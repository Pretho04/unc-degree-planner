# UNC Degree Planner

A local web app that finds which UNC-Chapel Hill majors and minors your completed courses count toward. For each program it shows what's left, the prerequisites for each remaining course, and live open seats.

## Run it

Double-click `start.bat`, or run:

```
powershell -ExecutionPolicy Bypass -File server.ps1
```

Your browser opens to http://localhost:8787. Leave the window open while you use the app. Press Ctrl+C to stop it.

You don't need to install anything: it uses Windows PowerShell.

## Importing your courses from a PDF

1. In ConnectCarolina, open your Tar Heel Tracker report or unofficial transcript and save it as a PDF. Print it and choose "Save as PDF" if there's no download button.
2. In the planner, click **Import from PDF** and pick the file.
3. Check the list it shows, then click **Add checked courses**:
   - **Completed** (letter grade, P, or transfer credit) and **In progress** are checked.
   - **Withdrawn, failed, or incomplete** courses are unchecked.
   - **Found without a grade** are unchecked too. These can be courses that are only *mentioned* in a requirement. Hover over one to see the line it came from.

The PDF is read in your browser and isn't uploaded anywhere. Scanned image PDFs have no text to read; for those, copy the text from ConnectCarolina and paste it into the course box.

## IDEAs in Action (gen eds)

The **IDEAs in Action** tab checks your courses against every gen-ed requirement. It uses each category's approved-course list from the catalog:
- First-Year Foundations
- the nine Focus Capacities plus the Lab
- Reflection and Integration
- Foundations of American Democracy

It follows the catalog's double-counting rules: each Focus Capacity needs its own course, and Research & Discovery and High-Impact can't share one. Set "I started at Carolina" so requirements that are new since fall 2025 only show if they apply to you.

Unfinished requirements list their approved courses. Courses that also count toward the major or minor open in **Details** are listed first. In **Details**, course options that would also fill an unfinished gen ed show a "Gen Ed: …" badge.

Use the checkboxes for things done outside a course: placement, exam credit, Launch sections, campus events, and athlete or ROTC exemptions. Not checked: Disciplinary Distribution, Supplemental General Education (B.A.), and Pass/Fail limits.

## How it works

| Data | Source | Cached |
| --- | --- | --- |
| Minor list and requirements | catalog.unc.edu program pages | 7 days (`cache/` folder) |
| Course descriptions and prereqs | catalog.unc.edu course lookup | 7 days |
| Sections and available seats | reports.unc.edu Class Search (public) | 2 minutes |

`server.ps1` is a small proxy: browsers can't call those UNC sites directly. All parsing happens in `public/app.js`. Your course list is saved in your browser.

Delete the `cache/` folder to force fresh catalog data.

## Limits

- Majors (95, including concentrations and tracks) cover only the major's own requirements. Gen eds are on the IDEAs in Action tab; the 120-hour total isn't checked.
- Programs that list concentrations, tracks or options in their own tables get a picker in **Details**. There are 23 of them, such as Media and Journalism, Data Science, the Physics options, and Creative Writing. "Best fit" picks the option where the most of your courses count. Some options add to shared requirements, like Journalism plus the shared POLI and ethics courses. Others are complete alternatives, like the Physics B.A. options. A "choose one emphasis" block inside a table becomes separate options too. For example, Classics "Combined Greek and Latin" has a Greek Emphasis and a Latin Emphasis.
- Course-level wording:
  - "above / beyond / over / higher than GREK 203" means **greater than** 203, so GREK 203 doesn't count.
  - "203 or higher", "at or above 200" and "300 and higher" include the number itself.
  - "at the 400 level" means 400–499.
  - Ranges like "between 400 and 699" or "401 - 492" are read as written.
  - "…with at least two (2) at or above the 200 level" is a **quota**, shown as a badge like "At least 2 at 200 and up: 1/2". Courses below that level can fill only the remaining slots. In the ENGL minor, two 100-level courses count 1 of 3, not 2. History's "at least six courses numbered 200 or above" is enforced on its 10-course total.
  - Counts in credits ("Nine (9) additional credits", "at least 9 credits from courses numbered 400 and above") are converted at about 3 credits per course.
  - Subject quotas are enforced too. "At least two of which must be AAAD classes" works like the level quotas. "With no more than two courses from other departments" means the rest must come from the program's own department, judged from its required courses (COMP for CS B.A.).
  - Department spread is enforced: "from at least two departments", "distributed over at least three academic departments", "representing at least three different subject codes". A course that would leave too few slots to reach the spread doesn't count, and it's labeled "can't count here". Departments are approximated by subject code. Departments with several codes count once: Psychology & Neuroscience (PSYC/NSCI), Classics (CLAR/CLAS/GREK/LATN), English & Comparative Literature (ENGL/CMPL), Art & Art History, Romance Studies, Germanic & Slavic, and Asian & Middle Eastern Studies. "Subject codes" wording counts each code separately.
  - Level-only wording that names no subject, like "One course numbered above 400" or "Seven additional courses above 204", is assumed to mean the program's own subject. That subject comes from the catalog's exclusion list if there is one ("not including BIOL 213…"), else the requirement's own courses, else its section, else the whole program. These show a "subject assumed" badge and a checkbox for anything satisfied another way. Examples: Biology minor → BIOL 401+, Biology majors → BIOL 201+, French → FREN 205+, Middle Eastern Languages → the ME language codes.
  - "In one … language" requires all the courses in a single language. "In a second … language" requires a single, different language.
  - Not checked: subfield or "area" spreads, like Religious Studies subfields or Social & Economic Justice areas.
- Level-based requirements have a **"Show courses that qualify"** list. It shows every catalog course in range, such as GREK 204 and up for "above GREK 203", with excluded courses removed. Each course shows live seats and a Details link for prereqs. Courses already counted and courses offered this term are listed first, and you can show only offered courses. Graduate courses (700+) are left out unless the requirement's range includes them.
- Requirements are parsed automatically from catalog pages that UNC writes in varied ways. All 95 majors and 102 of 106 minors parse into checkable requirements. For the rest, or for prose-only rules, the app shows a checkbox so you can mark them done yourself. Always compare against the official catalog link on each minor.
- Later tables only count as more requirements if they have their own "Total Hours" line. Course-by-language lists, organismal lists and pathway lists are reference material. Sentences that restrict other requirements ("no more than three courses below 200") appear under "Rules to keep in mind" and don't add courses. Overall totals ("a total of 10 HIST courses") only add courses beyond what the other requirements already need.
- Each course counts toward only one requirement within a minor. Rules about grade minimums, overlap with your major, and transfer credit aren't checked.
- The prereq check reads "A; B or C" as A **and** (B **or** C). Read the prereq text for unusual wording.
- Confirm your plan with Tar Heel Tracker and your advisor.
