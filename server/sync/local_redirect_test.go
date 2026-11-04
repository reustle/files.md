package sync

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/zakirullin/files.md/server/config"
)

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
