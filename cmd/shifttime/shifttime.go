package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Journal files are monthly (`2025.06 June.md`); the year/month come from the
// filename, the day from each `#### 27 June, Friday` header.
var (
	fileYearMonthRE = regexp.MustCompile(`(\d{4})\.(\d{2})`)
	dayHeaderRE     = regexp.MustCompile(`^#{2,4}\s+(\d{1,2})\b`)
	timeLineRE      = regexp.MustCompile("^`(\\d{2}):(\\d{2})`")
)

const dateLayout = "02.01.2006" // dd.mm.YYYY

type change struct {
	line   int    // 1-based line number
	oldStr string // the old `HH:MM` badge
	newStr string // the new `HH:MM` badge
	text   string // trimmed rest of the line, for the dry-run preview
}

// shiftContent shifts the `HH:MM` badge on every time line by `hours`. When
// hasRange is true, only records whose day (built from year/month + the current
// `#### DD` header) fall within [from, to] inclusive are shifted. Times wrap at
// midnight (23:30 +2h -> 01:30) but records stay under their original header.
func shiftContent(content string, hours int, hasRange bool, from, to time.Time, year, month int) (string, []change) {
	lines := strings.Split(content, "\n")
	var changes []change
	inRange := !hasRange // no range means every section qualifies

	for i, line := range lines {
		if m := dayHeaderRE.FindStringSubmatch(line); m != nil {
			if hasRange {
				day, _ := strconv.Atoi(m[1])
				d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
				inRange = !d.Before(from) && !d.After(to)
			}
			continue
		}

		if !inRange {
			continue
		}
		m := timeLineRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		t, err := time.Parse("15:04", m[1]+":"+m[2])
		if err != nil {
			continue
		}
		oldBadge := "`" + m[1] + ":" + m[2] + "`"
		newBadge := "`" + t.Add(time.Duration(hours)*time.Hour).Format("15:04") + "`"
		if oldBadge == newBadge {
			continue
		}
		lines[i] = strings.Replace(line, oldBadge, newBadge, 1)
		changes = append(changes, change{
			line:   i + 1,
			oldStr: oldBadge,
			newStr: newBadge,
			text:   strings.TrimSpace(line[len(oldBadge):]),
		})
	}

	return strings.Join(lines, "\n"), changes
}

// yearMonth extracts year and month from a journal filename like
// `2025.06 June.md`. ok is false when the name doesn't encode them.
func yearMonth(path string) (year, month int, ok bool) {
	m := fileYearMonthRE.FindStringSubmatch(filepath.Base(path))
	if m == nil {
		return 0, 0, false
	}
	year, _ = strconv.Atoi(m[1])
	month, _ = strconv.Atoi(m[2])
	return year, month, true
}

// collectFiles returns the .md files to process: the path itself if it's a
// file, or every .md file under it if it's a directory.
func collectFiles(path string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return []string{path}, nil
	}
	var files []string
	err = filepath.WalkDir(path, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.EqualFold(filepath.Ext(p), ".md") {
			files = append(files, p)
		}
		return nil
	})
	return files, err
}

func processFile(path string, hours int, hasRange bool, from, to time.Time, dryRun bool) (bool, error) {
	year, month, ok := yearMonth(path)
	if hasRange && !ok {
		// Can't place this file's days on a calendar, so a range can't be
		// applied. Skip it (rather than shift everything by surprise).
		fmt.Printf("skip %s: filename has no YYYY.MM, can't apply date range\n", path)
		return false, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}

	newContent, changes := shiftContent(string(data), hours, hasRange, from, to, year, month)
	if len(changes) == 0 {
		return false, nil
	}

	if dryRun {
		fmt.Printf("would modify %s (%d records):\n", path, len(changes))
		for _, c := range changes {
			fmt.Printf("  L%d  %s -> %s  %s\n", c.line, c.oldStr, c.newStr, c.text)
		}
	} else {
		if err := os.WriteFile(path, []byte(newContent), 0o644); err != nil {
			return false, err
		}
		fmt.Printf("modified %s (%d records)\n", path, len(changes))
	}
	return true, nil
}

func main() {
	from := flag.String("from", "", "start date (dd.mm.YYYY, inclusive); omit to shift all")
	to := flag.String("to", "", "end date (dd.mm.YYYY, inclusive); omit to shift all")
	hours := flag.Int("hours", 0, "hours to shift (may be negative)")
	dryRun := flag.Bool("dry-run", false, "print what would change without writing")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: shifttime --hours N [--from dd.mm.YYYY --to dd.mm.YYYY] [--dry-run] <file-or-journal-dir>")
		flag.PrintDefaults()
	}
	flag.Parse()

	path := flag.Arg(0)
	if path == "" || *hours == 0 {
		flag.Usage()
		os.Exit(2)
	}

	hasRange := *from != "" || *to != ""
	var fromDate, toDate time.Time
	if hasRange {
		if *from == "" || *to == "" {
			fmt.Fprintln(os.Stderr, "both --from and --to are required for a date range")
			os.Exit(2)
		}
		var err error
		if fromDate, err = time.Parse(dateLayout, *from); err != nil {
			fmt.Fprintf(os.Stderr, "invalid --from date %q (want dd.mm.YYYY)\n", *from)
			os.Exit(2)
		}
		if toDate, err = time.Parse(dateLayout, *to); err != nil {
			fmt.Fprintf(os.Stderr, "invalid --to date %q (want dd.mm.YYYY)\n", *to)
			os.Exit(2)
		}
		if toDate.Before(fromDate) {
			fmt.Fprintln(os.Stderr, "--to is before --from")
			os.Exit(2)
		}
	}

	files, err := collectFiles(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error reading path:", err)
		os.Exit(1)
	}

	modified := 0
	for _, f := range files {
		changed, err := processFile(f, *hours, hasRange, fromDate, toDate, *dryRun)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error processing %s: %v\n", f, err)
			continue
		}
		if changed {
			modified++
		}
	}

	verb := "modified"
	if *dryRun {
		verb = "would modify"
	}
	fmt.Printf("\nDone. %s %d file(s).\n", verb, modified)
}
