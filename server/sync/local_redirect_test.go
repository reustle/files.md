package sync

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/zakirullin/files.md/server/config"
)

func TestWorkspacePathIsOnlyShownToAuthenticatedLocalUsers(t *testing.T) {
	old := config.ServerCfg
	t.Cleanup(func() { config.ServerCfg = old })
	config.ServerCfg = config.Config{RequireSafeSync: true, LocalNotesDir: "/notes/Personal", TokensDir: t.TempDir()}
	const token = "workspace-label-test"
	require.NoError(t, os.WriteFile(filepath.Join(config.ServerCfg.TokensDir, hashToken(token)), []byte("1"), 0600))
	for _, authenticated := range []bool{false, true} {
		request := httptest.NewRequest(http.MethodGet, "/session", nil)
		if authenticated {
			request.AddCookie(&http.Cookie{Name: AuthCookieName, Value: token})
		}
		response := httptest.NewRecorder()
		SessionStatus(response, request)
		var status map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
		require.Equal(t, authenticated, status["authenticated"])
		if authenticated {
			require.Equal(t, "/notes/Personal", status["workspacePath"])
		} else {
			require.NotContains(t, status, "workspacePath")
		}
	}
}

func TestLocalAlternateHostRedirectsToConfiguredHTTPS(t *testing.T) {
	old := config.ServerCfg
	t.Cleanup(func() { config.ServerCfg = old })
	config.ServerCfg = config.Config{RequireSafeSync: true, AppURL: "https://notes.example:8444"}
	handler := router(log.New(io.Discard, "", 0))
	for _, host := range []string{"omarchy-dell:8080", "100.127.33.3:8080"} {
		request := httptest.NewRequest(http.MethodGet, "http://"+host+"/folder%20name?token=test-login", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusTemporaryRedirect, response.Code)
		require.Equal(t, "https://notes.example:8444/folder%20name?token=test-login", response.Header().Get("Location"))
		require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	}
}

func TestAlternateHostRedirectOnlyAppliesToSecureLocalServer(t *testing.T) {
	old := config.ServerCfg
	t.Cleanup(func() { config.ServerCfg = old })
	for _, cfg := range []config.Config{
		{AppURL: "https://notes.example"},
		{RequireSafeSync: true, AppURL: "http://notes.example"},
		{RequireSafeSync: true},
	} {
		config.ServerCfg = cfg
		response := httptest.NewRecorder()
		router(log.New(io.Discard, "", 0)).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://other:8080/", nil))
		require.Equal(t, http.StatusNotFound, response.Code)
		require.Empty(t, response.Header().Get("Location"))
	}
}

func TestReconnectIsNotBlockedByAnotherTabsMissingOrStaleCookie(t *testing.T) {
	old := config.ServerCfg
	t.Cleanup(func() { config.ServerCfg = old })
	config.ServerCfg = config.Config{RequireSafeSync: true, TokensDir: t.TempDir()}
	const validToken = "reconnect-test-token"
	require.NoError(t, os.WriteFile(filepath.Join(config.ServerCfg.TokensDir, hashToken(validToken)), []byte("1"), 0600))
	const remote = "192.0.2.245:1234"
	const ip = "192.0.2.245"
	t.Cleanup(func() {
		blockedIPsMutex.Lock()
		delete(blockedIPs, ip)
		blockedIPsMutex.Unlock()
	})
	handler := tokenMiddleware(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, step := range []struct {
		token  string
		status int
	}{
		{"", http.StatusUnauthorized},
		{validToken, http.StatusNoContent},
		{"stale-token", http.StatusUnauthorized},
		{validToken, http.StatusNoContent},
		{"stale-token", http.StatusTooManyRequests},
		{"", http.StatusUnauthorized},
		{validToken, http.StatusNoContent},
	} {
		request := httptest.NewRequest(http.MethodPost, "/notes/sync", nil)
		request.RemoteAddr = remote
		request.Header.Set("X-FilesMD-Sync", "3")
		if step.token != "" {
			request.AddCookie(&http.Cookie{Name: AuthCookieName, Value: step.token})
		}
		response := httptest.NewRecorder()
		handler(response, request)
		require.Equal(t, step.status, response.Code)
	}
}
