package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func mustDate(s string) time.Time {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestShiftAllNoRange(t *testing.T) {
	r := require.New(t)

	in := "#### 27 June, Friday\n`09:00` a\n`10:30` b\n"
	out, changes := shiftContent(in, 2, false, time.Time{}, time.Time{}, 0, 0)

	r.Equal("#### 27 June, Friday\n`11:00` a\n`12:30` b\n", out)
	r.Len(changes, 2)
}

func TestShiftNegativeHours(t *testing.T) {
	r := require.New(t)

	in := "`10:00` a\n"
	out, _ := shiftContent(in, -3, false, time.Time{}, time.Time{}, 0, 0)

	r.Equal("`07:00` a\n", out)
}

func TestShiftOnlyWithinRange(t *testing.T) {
	r := require.New(t)

	in := "#### 27 June, Friday\n`09:00` in\n#### 30 June, Monday\n`09:00` out\n"
	out, changes := shiftContent(in, 2, true, mustDate("27.06.2025"), mustDate("28.06.2025"), 2025, 6)

	r.Equal("#### 27 June, Friday\n`11:00` in\n#### 30 June, Monday\n`09:00` out\n", out)
	r.Len(changes, 1)
}

func TestShiftRangeBoundsAreInclusive(t *testing.T) {
	r := require.New(t)

	in := "#### 27 June, Friday\n`09:00` from-day\n#### 28 June, Saturday\n`09:00` to-day\n"
	out, changes := shiftContent(in, 1, true, mustDate("27.06.2025"), mustDate("28.06.2025"), 2025, 6)

	r.Equal("#### 27 June, Friday\n`10:00` from-day\n#### 28 June, Saturday\n`10:00` to-day\n", out)
	r.Len(changes, 2)
}

func TestShiftMidnightWrapStaysUnderHeader(t *testing.T) {
	r := require.New(t)

	in := "#### 27 June, Friday\n`23:30` late\n"
	out, _ := shiftContent(in, 2, false, time.Time{}, time.Time{}, 0, 0)

	r.Equal("#### 27 June, Friday\n`01:30` late\n", out)
}

func TestShiftLeavesNonTimeLinesUntouched(t *testing.T) {
	r := require.New(t)

	in := "#### 27 June, Friday\njust prose, no badge\n`09:00` real\n"
	out, changes := shiftContent(in, 2, false, time.Time{}, time.Time{}, 0, 0)

	r.Equal("#### 27 June, Friday\njust prose, no badge\n`11:00` real\n", out)
	r.Len(changes, 1)
}

func TestYearMonthFromJournalFilename(t *testing.T) {
	r := require.New(t)

	year, month, ok := yearMonth("/x/journal/2025.06 June.md")

	r.True(ok)
	r.Equal(2025, year)
	r.Equal(6, month)
}

func TestYearMonthMissing(t *testing.T) {
	r := require.New(t)

	_, _, ok := yearMonth("/x/Notes.md")

	r.False(ok)
}
