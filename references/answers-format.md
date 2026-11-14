# Answers file format

`fill` and `submit` accept either an inline JSON string or a path to a `.json` file.

## Shape

```json
{
  "type": "match | short | choice | multi | judge | gap | attach | mixed",
  "answers": {
    "1": ["a", "b", "c", "d"],
    "2": ["a", "b", "c", "d"]
  }
}
```

- `type` is optional; each question's type is auto-detected from the page. Use `"mixed"` (or omit
  `type`) for a paper that combines several question types.
- `answers` keys are 1-based question numbers.
- A bare map is accepted: `{ "1": [...], "2": [...] }` is treated as `{ answers: ... }`.
- Uppercase letters are accepted for match/choice/multi; they are normalized.

## match

Each value is an array of option letters, one per left-hand slot **in row order** (A, B, C, …).

```json
{
  "type": "match",
  "answers": {
    "1": ["a", "b", "c", "d", "e", "f"],
    "2": ["a", "b", "c", "d"],
    "3": ["a", "b", "c", "d"]
  }
}
```

Rules:
- The array length must equal the number of `.left_answer` selects in that question.
- The options shown in `state` are shared by all slots of the same question.
- Every slot must end with exactly one selected tag; duplicates or empty slots are rejected.

## short

Each value is the full answer text (a string, or a one-element array).

```json
{
  "type": "short",
  "answers": {
    "1": "国际收支反映一国对外经济往来的全貌……",
    "2": "经常项目包括货物、服务、初次收入和二次收入……"
  }
}
```

Rules:
- The editor is Draft.js; text is inserted as a single block.
- Avoid `\n` in the answer; use Chinese punctuation and numbered clauses.
- Verification compares whitespace-normalized text.

## choice

Each value is the option letter.

```json
{
  "type": "choice",
  "answers": { "1": "D", "2": "A", "3": "B", "4": "A", "5": "B" }
}
```

Rules:
- Exactly one radio per question must be checked.
- Letters map by option index; a leading `A.` / `B.` prefix is optional.

## multi

Each value is an array of option letters (or option texts).

```json
{
  "type": "multi",
  "answers": { "1": ["A", "C", "D"], "2": ["B"] }
}
```

Rules:
- The driver clicks only the difference between the current and target checked sets.
- Verification compares the checked set exactly, so extra checked options fail.
- The "其他" checkbox's free-text box is ignored unless its option text is targeted explicitly.

## judge

Each value is the judgement. Accepted forms: `正确/错误`, `对/错`, `true/false`, `T/F`, `√/×`,
`A/B` (A = 正确, B = 错误).

```json
{
  "type": "judge",
  "answers": { "1": "正确", "2": "错误" }
}
```

Rules:
- The driver maps the value to the option label first, then falls back to option index.
- Verification compares the checked radio's label.

## gap

Each value is an array of strings, one per blank **in DOM order**.

```json
{
  "type": "gap",
  "answers": {
    "1": ["第一个空", "第二个空"],
    "2": ["只有一個空"]
  }
}
```

Rules:
- The array length must equal the number of textareas/inputs in the question.
- Values are written with the native setter and `input`/`change` events, with a
  focus + `Input.insertText` fallback.
- Verification reads every field back and compares whitespace-normalized values.

## attach

Each value is an array of absolute local file paths. The platform accepts up to 9 attachments per
question.

```json
{
  "type": "attach",
  "answers": {
    "1": ["C:\\Users\\me\\Desktop\\report.pdf"],
    "2": ["C:\\Users\\me\\Desktop\\data.xlsx"]
  }
}
```

Rules:
- Files are set on the question's `input[type=file]` via `DOM.setFileInputFiles`.
- The driver polls the rendered file names for up to 90 s and compares basenames.
- A file that never appears in the list is reported as `FAIL`.

## Generating answers from `state`

1. Run `node scripts/whut.mjs state`.
2. For mixed/unknown papers, run `probe` to inspect `type`, `controls`, `options`, `blanks`.
3. For match: map each left item to the option whose text matches the standard/label.
4. For short: write the answer for each stem.
5. For choice/judge/multi: pick the option letter(s) or judgement.
6. For gap: provide one value per blank in order.
7. For attach: provide absolute file paths.
8. Save as `answers.json`, run `fill`, then show the user the summary.
9. After approval, run `submit` with the same file.

`submit` requires the answer file to cover **all** questions on the page and, for match, the exact
slot count. It will abort (exit code 2) rather than submit a partial paper.
