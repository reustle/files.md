package sync

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/spf13/afero"

	"github.com/zakirullin/files.md/server/config"
	"github.com/zakirullin/files.md/server/fs"
)

const (
	TokenLength            = 32
	OneTimeTokenExpiration = 10 * time.Minute
	BanForInvalidToken     = 10 * time.Minute
	AuthCookieName         = "token"
	AuthCookieMaxAge       = 10 * 365 * 24 * 60 * 60 // ~10 years
)

var (
	oneTimeTokens = make(map[string]oneTimeToken)
	mu            sync.RWMutex
)

var safeSyncMu sync.Mutex

var blockedIPs = make(map[string]time.Time)
var blockedIPsMutex sync.RWMutex

type oneTimeToken struct {
	userID    int64
	expiresAt time.Time
}

func GenOneTimeToken(userID int64) string {
	token := genToken()

	mu.Lock()
	oneTimeTokens[token] = oneTimeToken{
		userID:    userID,
		expiresAt: time.Now().Add(OneTimeTokenExpiration),
	}
	mu.Unlock()

	return token
}

func findUserID(token string) (int64, bool) {
	tokens, err := fs.NewFS(config.ServerCfg.TokensDir, afero.NewOsFs())
	if err != nil {
		slog.Error("Failed to create file system for tokens", "error", err)
		return 0, false
	}

	data, err := tokens.Read("/", hashToken(token))
	if err != nil {
		return 0, false
	}

	userID, err := strconv.ParseInt(data, 10, 64)
	if err != nil {
		return 0, false
	}

	return userID, true
}

func setAuthCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     AuthCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   AuthCookieMaxAge,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteNoneMode,
	})
}

// SessionStatus lets a fresh browser origin discover an existing login cookie.
// Opening the app without a cookie is normal; this read-only probe must not
// trigger the sync middleware's invalid-token IP ban.
func SessionStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	authenticated := false
	if cookie, err := r.Cookie(AuthCookieName); err == nil && cookie.Value != "" {
		_, authenticated = findUserID(cookie.Value)
	}
	w.Header().Set("Content-Type", "application/json")
	status := map[string]any{"authenticated": authenticated}
	if authenticated && config.ServerCfg.RequireSafeSync && config.ServerCfg.LocalNotesDir != "" {
		status["workspacePath"] = config.ServerCfg.LocalNotesDir
	}
	_ = json.NewEncoder(w).Encode(status)
}

func IssueToken(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC in IssueToken: %v", r)
			http.Error(w, "Internal server error", 500)
		}
	}()

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	permanentToken, ok := issueNewPermanentToken(r)
	if !ok {
		// issueNewPermanentToken already logged the precise sub-reason.
		http.Error(w, "Invalid or expired token", http.StatusUnauthorized)
		return
	}

	setAuthCookie(w, permanentToken)

	w.Header().Set("Content-Type", "application/json")
	err := json.NewEncoder(w).Encode(map[string]string{"token": permanentToken})
	if err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		return
	}
}

// TODO CHECK that user id belongs to oneTimeToken ID, or get user id by oneTimeToken
// TODO add tests
// TODO too harsh blocking, we may need to take into account proxies
func tokenMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if config.ServerCfg.RequireSafeSync && r.Header.Get("X-FilesMD-Sync") != "3" {
			http.Error(w, "This server requires the updated sync client. Reload the app.", http.StatusConflict)
			return
		}
		if config.ServerCfg.RequireSafeSync {
			switch r.URL.Path {
			case "/syncFilenames", "/syncFile", "/syncTexts", "/syncText":
				http.Error(w, "Reload the app to use content-versioned notes sync", http.StatusConflict)
				return
			}
			safeSyncMu.Lock()
			defer safeSyncMu.Unlock()
		}
		ip := getIPFromRemoteAddr(r.RemoteAddr)

		blockedIPsMutex.RLock()
		blockedUntil, isBlocked := blockedIPs[ip]
		blockedIPsMutex.RUnlock()
		if isBlocked && time.Now().Before(blockedUntil) {
			// 429s are too noisy to log — a blocked IP can replay them every
			// few seconds. The originating 401 has already been recorded.
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}

		// Try cookie first, fall back to Authorization header.
		var token string
		fromCookie := false
		if cookie, err := r.Cookie(AuthCookieName); err == nil && cookie.Value != "" {
			token = cookie.Value
			fromCookie = true
		}
		if token == "" {
			token = r.Header.Get("Authorization")
		}

		userID, ok := findUserID(token)
		if !ok {
			blockedIPsMutex.Lock()
			blockedIPs[ip] = time.Now().Add(BanForInvalidToken)
			blockedIPsMutex.Unlock()

			logAuthFailure("middleware_invalid_token_401", r, map[string]any{
				"http_status":     401,
				"token_source":    map[bool]string{true: "cookie", false: "auth_header"}[fromCookie],
				"token_empty":     token == "",
				"new_block_until": time.Now().Add(BanForInvalidToken).Format(time.RFC3339Nano),
				"new_block_for":   BanForInvalidToken.String(),
			})

			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		// Migrate old clients from Authorization header to cookie.
		if !fromCookie {
			setAuthCookie(w, token)
		}

		ctx := context.WithValue(r.Context(), "userID", userID)
		next(w, r.WithContext(ctx))
	}
}

// TODO add tests
func issueNewPermanentToken(r *http.Request) (string, bool) {
	r.Body = http.MaxBytesReader(nil, r.Body, MaxTokenSize)

	var req struct {
		OneTimeToken string `json:"oneTimeToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logAuthFailure("onetime_swap_body_decode_error_401", r, map[string]any{
			"http_status": 401,
			"decode_err":  err.Error(),
		})
		return "", false
	}

	mu.Lock()
	data, exists := oneTimeTokens[req.OneTimeToken]
	if !exists || time.Now().After(data.expiresAt) {
		// Snapshot a few one-time tokens for cross-referencing — fingerprints
		// only, never any portion of the raw token (still-live secrets).
		samplePrefixes := make([]string, 0, 5)
		now := time.Now()
		var liveCount, expiredCount int
		for tok, d := range oneTimeTokens {
			if now.After(d.expiresAt) {
				expiredCount++
			} else {
				liveCount++
			}
			if len(samplePrefixes) < 5 {
				samplePrefixes = append(samplePrefixes,
					fmt.Sprintf("%s(uid=%d,exp=%s)", tokenFingerprint(tok), d.userID, d.expiresAt.Format(time.RFC3339)))
			}
		}
		mu.Unlock()

		reason := "onetime_token_not_in_map_401"
		if exists {
			reason = "onetime_token_expired_401"
		}
		extras := map[string]any{
			"http_status":           401,
			"submitted_token":       tokenFingerprint(req.OneTimeToken),
			"submitted_token_blank": req.OneTimeToken == "",
			"map_live_count":        liveCount,
			"map_expired_count":     expiredCount,
			"map_sample":            strings.Join(samplePrefixes, ","),
			"new_block_for":         "1m",
		}
		if exists {
			extras["matched_user_id"] = data.userID
			extras["matched_expires_at"] = data.expiresAt.Format(time.RFC3339Nano)
			extras["matched_age"] = time.Since(data.expiresAt.Add(-OneTimeTokenExpiration)).String()
		}
		logAuthFailure(reason, r, extras)

		return "", false
	}
	delete(oneTimeTokens, req.OneTimeToken)
	mu.Unlock()

	token := genToken()
	tokens, err := fs.NewFS(config.ServerCfg.TokensDir, afero.NewOsFs())
	if err != nil {
		slog.Error("Failed to create file system for tokens", "error", err)
		logAuthFailure("onetime_swap_fs_init_error_401", r, map[string]any{
			"http_status": 401,
			"err":         err.Error(),
			"user_id":     data.userID,
		})
		return "", false
	}
	err = tokens.Write(fs.DirUserRoot, hashToken(token), strconv.FormatInt(data.userID, 10))
	if err != nil {
		logAuthFailure("onetime_swap_write_error_401", r, map[string]any{
			"http_status": 401,
			"err":         err.Error(),
			"user_id":     data.userID,
		})
		return "", false
	}

	return token, true
}

func genToken() string {
	bytes := make([]byte, TokenLength)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func hashToken(token string) string {
	// A token is a server-generated 32 bytes of entropy, so SHA-256 is fine here.
	// At 1 billion SHA256 hashes per second it would take ~10^60 years to brute force.
	h := sha256.New()
	h.Write([]byte(token + config.ServerCfg.TokensSalt))
	return hex.EncodeToString(h.Sum(nil))
}

func getIPFromRemoteAddr(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		// If SplitHostPort fails, might be just an IP without port
		if ip := net.ParseIP(remoteAddr); ip != nil {
			return remoteAddr
		}
		return "unknown"
	}
	return host
}
