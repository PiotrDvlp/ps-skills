## Mode

gate

## Contract

Task T1: VAT amount

Files:
- Create: `helpers/vat.ts`
- Create: `helpers/__tests__/vat.test.ts`

`export function vatAmount(netCents: number): number` takes `netCents >= 0` and returns 19 % of it, rounded half up to whole cents. Example: `vatAmount(1000)` is `190`.

## Existing files

`helpers/money.ts`:

```ts
export function roundCents(x: number): number {
  return Math.round(x)
}
```

## Stub

`helpers/vat.ts`:

```ts
export function vatAmount(netCents: number): number {
  return undefined as never
}
```

## Cases to write

Write one test case for each of these, with the name given here as its report name:

- `contract-example`: net amount 1000.
- `half-cent`: net amount 1050.
- `zero`: net amount 0.

## This run

You have no tools in this run: you cannot read, write or run files. Give each file you create or change in full, as a fenced code block whose info line holds the language and the file path. Then write your report. Put the per-case part of the report between a line `BEGIN CASE REPORT` and a line `END CASE REPORT`, with one section per case, each starting with a line `case: <name>`. The rest of the report goes after `END CASE REPORT`.
