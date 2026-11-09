package main

import (
	"reflect"
	"testing"
)

// Work Board 802e566a (2026-11-09): a Windows customer ran the install-link
// command `Start-Process Empir3Setup.exe -ArgumentList "--pair","<code>"`
// four times and the Bridge never paired. Release payloads ship
// Empir3Tray.exe, so main() takes the tray launch path and runs the payload
// once with launcherPrepArgs(args). The payload redeems the install link only
// when its own argv carries `--pair <code>` (payload-entry.js), so these args
// are the whole install-link handoff.
func TestLauncherPrepArgsForwardsInstallLinkPairCode(t *testing.T) {
	code := "a1b2c3d4e5f60718"
	got := launcherPrepArgs([]string{"--pair", code})
	want := []string{"--launcher-prep", "--pair", code}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("launcherPrepArgs dropped the install-link pairing code: got %q, want %q", got, want)
	}
}

func TestLauncherPrepArgsWithoutPairCode(t *testing.T) {
	for _, args := range [][]string{nil, {}, {"--daemon"}} {
		got := launcherPrepArgs(args)
		if !reflect.DeepEqual(got, []string{"--launcher-prep"}) {
			t.Fatalf("launcherPrepArgs(%q) = %q, want only --launcher-prep", args, got)
		}
	}
}

func TestLauncherPrepArgsIgnoresPairWithoutUsableCode(t *testing.T) {
	// A trailing --pair, or one followed by another flag, has no code to
	// redeem; forwarding it would make the payload try to claim "--daemon".
	for _, args := range [][]string{{"--pair"}, {"--pair", "--daemon"}, {"--pair", ""}} {
		got := launcherPrepArgs(args)
		if !reflect.DeepEqual(got, []string{"--launcher-prep"}) {
			t.Fatalf("launcherPrepArgs(%q) = %q, want only --launcher-prep", args, got)
		}
	}
}

func TestLauncherPrepArgsNeverForwardsOtherFlags(t *testing.T) {
	// --launcher-prep must stay a prep step: forwarding --daemon or --mcp would
	// make the payload start a second daemon or an MCP shim before the tray.
	got := launcherPrepArgs([]string{"--daemon", "--pair", "c0de-1234", "--mcp"})
	want := []string{"--launcher-prep", "--pair", "c0de-1234"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}
