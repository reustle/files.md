package server

import (
	"fmt"

	"github.com/zakirullin/files.md/server/config"
	"github.com/zakirullin/files.md/server/fs"
	"github.com/zakirullin/files.md/server/i18n"
	"github.com/zakirullin/files.md/server/pkg/tg"
	"github.com/zakirullin/files.md/server/pkg/txt"
)

const (
	addBtn = "➕"
	delBtn = "➖"
)

var AvailableMoveToBtns = []tg.Btn{
	tg.NewBtn(i18n.StrToTomorrow, tg.NewCmd(CmdScheduleForTmrw, nil)),
	tg.NewBtn(i18n.StrToLater, tg.NewCmd(CmdMoveToLater, nil)),
	tg.NewBtn(i18n.StrToADay, tg.NewCmd(CmdShowScheduleForDay, nil)),
	tg.NewBtn(i18n.StrToFile, tg.NewCmd(CmdShowMoveToDirOrFile, nil)),
	tg.NewBtn(i18n.StrToJournal, tg.NewCmd(CmdMoveToJournal, nil)),
	tg.NewBtn(i18n.StrToRead, tg.NewCmd(CmdMoveToRead, nil)),
	tg.NewBtn(i18n.StrToWatch, tg.NewCmd(CmdMoveToWatch, nil)),
	tg.NewBtn(i18n.StrToShop, tg.NewCmd(CmdMoveToShop, nil)),
	tg.NewBtn(i18n.StrToChecklist, tg.NewCmd(CmdShowMoveToChecklist, nil)),
}

var AvailableQuickBtns = []tg.Btn{
	tg.NewBtn("Later", tg.NewCmd(CmdLater, nil)),
	tg.NewBtn("Search", tg.NewCustomCmd(CmdInlineQuerySearchEveryWhere, nil, tg.CmdTypeInlineQueryCurrentChat)),
	tg.NewBtn("Files", tg.NewCmd(CmdShowFiles, nil)),
	tg.NewBtn("Checklists", tg.NewCmd(CmdShowChecklists, nil)),
	tg.NewBtn("Postpone", tg.NewCmd(CmdShowPostpone, nil)),
	tg.NewBtn("Read", tg.NewCmd(CmdShowReadChecklist, nil)),
	tg.NewBtn("Watch", tg.NewCmd(CmdShowWatchChecklist, nil)),
	tg.NewBtn("Shop", tg.NewCmd(CmdShowShopChecklist, nil)),
	tg.NewBtn("Schedule", tg.NewCmd(CmdShowSchedule, nil)),
	tg.NewBtn("Habits", tg.NewCustomCmd(CmdWebAppHabits, nil, tg.CmdTypeWebApp)),
	tg.NewBtn("Random", tg.NewCmd(CmdRandomNote, nil)),
}

func (b *Bot) showSettings(_ []string) error {
	var kb tg.Keyboard
	kb.AddRow(tg.NewBtn(txt.Emoji(i18n.Emoji("brain"), b.tr("Full mode")), tg.NewCmd(CmdFullMode, nil)))
	kb.AddRow(tg.NewBtn(txt.Emoji(i18n.Emoji("notes"), b.tr("Notes mode")), tg.NewCmd(CmdNotesOnlyMode, nil)))
	kb.AddRow(tg.NewBtn(txt.Emoji(i18n.Emoji("tasks"), b.tr("Tasks mode")), tg.NewCmd(CmdTasksOnlyMode, nil)))
	//kb.AddRow(tg.NewBtn(txt.Emoji(i18n.Emoji("journal"), b.tr("Journal mode")), tg.NewCmd(CmdJournalOnlyMode, nil)))
	kb.AddRow(tg.NewBtn("-", tg.NewCmd(CmdDoNothing, nil)))
	kb.AddRow(tg.NewBtn(i18n.StrQuickBtns, tg.NewCmd(CmdShowQuickBtnsSettings, nil)))
	kb.AddRow(tg.NewBtn(i18n.StrMoveToBtns, tg.NewCmd(CmdShowMoveToBtnsSettings, nil)))
	kb.AddRow(tg.NewBtn(txt.Emoji(i18n.Emoji("world"), b.tr("Timezone")), tg.NewCmd(CmdShowTimezone, nil)))
	kb.AddRow(tg.NewBtn(i18n.StrHome, tg.NewCmd(CmdShowHome, nil)))

	err := b.showHTML("Settings:", &kb)
	if err != nil {
		return fmt.Errorf("showSettings : %w", err)
	}

	return nil
}

func (b *Bot) showTimezone(_ []string) error {
	var kb tg.Keyboard
	timezones := []string{
		"UTC",

		// Europe
		"Europe/Belgrade",
		"Europe/Berlin",
		"Europe/Istanbul",
		"Europe/London",
		"Europe/Madrid",
		"Europe/Moscow",
		"Europe/Paris",
		"Europe/Podgorica",
		"Europe/Warsaw",

		// Asia
		"Asia/Almaty",
		"Asia/Colombo",
		"Asia/Nicosia",
		"Asia/Tbilisi",
		"Asia/Tokyo",

		// Africa
		"Africa/Cairo",
		"Africa/Johannesburg",

		// Americas
		"America/Buenos_Aires",
		"America/Lima",
		"America/Los_Angeles",
		"America/New_York",
		"America/Santiago",
	}

	for _, tz := range timezones {
		name := tz
		if b.cfg.Timezone().String() == tz {
			name = "✅ " + name
		}
		kb.AddRow(tg.NewBtn(name, tg.NewCmd(CmdSetTimezone, []string{tz})))
	}
	kb.AddRow(tg.NewBtn(i18n.StrHome, tg.NewCmd(CmdShowHome, nil)))

	err := b.showHTML("Timezone:", &kb)
	if err != nil {
		return fmt.Errorf("showTimezone : %w", err)
	}

	return nil
}

func (b *Bot) setTimezone(params []string) error {
	timezone := params[0]

	err := b.cfg.SetTimezone(timezone)
	if err != nil {
		return fmt.Errorf("setTimezone : %w", err)
	}

	return b.ShowHome(nil)
}

func (b *Bot) showQuickBtnsSettings(params []string) error {
	var kb tg.Keyboard

	// Step 1. Append all buttons that are already chosen by user
	var usedCmds []string

	// We iterate through hardcoded panel to preserve order of buttons in UI
	cmds, err := b.cfg.QuickCmds()
	if err != nil {
		return fmt.Errorf("can't get quick cmds: %w", err)
	}

	for _, cmd := range cmds {
		for _, btn := range AvailableQuickBtns {
			if btn.Cmd.Name != cmd {
				continue
			}

			name := fmt.Sprintf("%s %s %s", i18n.Emoji(btn.Name), btn.Name, delBtn)
			enabledCmd := tg.NewCmd(CmdDelFromQuickBtns, []string{btn.Cmd.Name})
			kb.AddRow(tg.NewBtn(name, enabledCmd))
			usedCmds = append(usedCmds, cmd)
			break
		}
	}

	kb.AddRow(tg.NewBtn("-", tg.NewCmd(CmdDoNothing, nil)))

	// Step 2. now, let's fill buttons that are not disabled...
	for _, btn := range AvailableQuickBtns {
		// Check if command is enabled
		cmdUsed := false
		for _, usedCmd := range usedCmds {
			if btn.Cmd.Name == usedCmd {
				cmdUsed = true
			}
		}
		if cmdUsed {
			continue
		}
		// Command is not enabled, so add it to disabled list
		name := fmt.Sprintf("%s %s %s", i18n.Emoji(btn.Name), btn.Name, addBtn)
		disabledCmd := tg.NewCmd(CmdAddToQuickBtns, []string{btn.Cmd.Name})
		kb.AddRow(tg.NewBtn(name, disabledCmd))
	}

	kb.AddRow(tg.NewBtn(i18n.StrHome, tg.NewCmd(CmdShowHome, nil)))

	text := fmt.Sprintf("Configure quick buttons (%s = add to quick buttons, %s = to remove from quick buttons):", addBtn, delBtn)
	err = b.showHTML(text, &kb)
	if err != nil {
		return fmt.Errorf("configureQuickPanel : %w", err)
	}

	return nil
}

func (b *Bot) addToQuickBtns(params []string) error {
	cmd := params[0]

	// Search whether a command is valid
	found := false
	for _, btn := range AvailableQuickBtns {
		if btn.Cmd.Name == cmd {
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("unknown command: %s", cmd)
	}

	if cmd == "Habits" {
		b.fs.CreateDirsIfNotExist(fs.DirHabits, fs.DirInsights)
	}

	err := b.cfg.AddQuickCmd(cmd)
	if err != nil {
		return fmt.Errorf("can't add to quick buttons: %w", err)
	}

	return b.showQuickBtnsSettings([]string{})
}

func (b *Bot) delFromQuickBtns(params []string) error {
	cmd := params[0]

	_ = b.cfg.DelQuickCmd(cmd)

	return b.showQuickBtnsSettings([]string{})
}

func (b *Bot) quickBtns() []tg.Btn {
	quickBtnsRow := tg.NewRow()
	// We can tolerate missing quick btns
	cmds, _ := b.cfg.QuickCmds()
	for _, cmd := range cmds {
		for _, btn := range AvailableQuickBtns {
			if btn.Cmd.Name == cmd {
				if btn.Cmd.Name == CmdWebAppHabits {
					habitsUrl := fmt.Sprintf("%s/habits_v2/%d", config.ServerCfg.APIURL, b.userID)
					btn.Cmd.Params = []string{habitsUrl}
				}
				btn.Name = i18n.Emoji(btn.Name)

				quickBtnsRow = append(quickBtnsRow, btn)
				break
			}
		}
	}

	return quickBtnsRow
}

// A little copy-paste from showQuickBtnsSettings
func (b *Bot) showMoveToBtnsSettings(params []string) error {
	var kb tg.Keyboard

	// Step 1. Append all buttons that are already chosen by user
	var usedCmds []string

	// We iterate through hardcoded panel to preserve order of buttons in UI
	cmds, err := b.cfg.MoveToCmds()
	if err != nil {
		return fmt.Errorf("can't get move to cmds: %w", err)
	}
	for _, cmd := range cmds {
		for _, btn := range AvailableMoveToBtns {
			if btn.Cmd.Name != cmd {
				continue
			}

			name := txt.Emoji(delBtn, btn.Name)
			enabledCmd := tg.NewCmd(CmdDelFromMoveToBtns, []string{btn.Cmd.Name})
			kb.AddRow(tg.NewBtn(name, enabledCmd))
			usedCmds = append(usedCmds, cmd)
			break
		}
	}

	kb.AddRow(tg.NewBtn("-", tg.NewCmd(CmdDoNothing, nil)))

	// Step 2. now, let's fill buttons that are not disabled...
	for _, btn := range AvailableMoveToBtns {
		// Check if command is enabled
		cmdUsed := false
		for _, usedCmd := range usedCmds {
			if btn.Cmd.Name == usedCmd {
				cmdUsed = true
			}
		}
		if cmdUsed {
			continue
		}
		// Command is not enabled, so add it to disabled list
		name := txt.Emoji(addBtn, btn.Name)
		disabledCmd := tg.NewCmd(CmdAddToMoveToBtns, []string{btn.Cmd.Name})
		kb.AddRow(tg.NewBtn(name, disabledCmd))
	}

	kb.AddRow(tg.NewBtn(i18n.StrHome, tg.NewCmd(CmdShowHome, nil)))

	text := fmt.Sprintf("Configure quick panel (%s = add to panel, %s = to remove):", addBtn, delBtn)
	err = b.showHTML(text, &kb)
	if err != nil {
		return fmt.Errorf("configureQuickPanel : %w", err)
	}

	return nil
}

func (b *Bot) addToMoveToBtns(params []string) error {
	cmd := params[0]

	err := b.cfg.AddMoveToCmd(cmd)
	if err != nil {
		return fmt.Errorf("can't add to move to buttons: %w", err)
	}

	return b.showMoveToBtnsSettings([]string{})
}

func (b *Bot) delFromMoveToBtns(params []string) error {
	cmd := params[0]

	err := b.cfg.DelMoveToCmd(cmd)
	if err != nil {
		return fmt.Errorf("button doesn't exist in user's prefs: %s", params[0])
	}

	return b.showMoveToBtnsSettings([]string{})
}

func (b *Bot) moveToBtns(msgHash string) []tg.Btn {
	moveToBtns := tg.NewRow()

	cmds, err := b.cfg.MoveToCmds()
	if err != nil {
		return nil
	}

	for _, cmd := range cmds {
		for _, btn := range AvailableMoveToBtns {
			if btn.Cmd.Name == cmd {
				btn.Cmd.Params = []string{msgHash}
				moveToBtns = append(moveToBtns, btn)
				break
			}
		}
	}

	return moveToBtns
}
