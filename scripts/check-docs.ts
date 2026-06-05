// deno-lint-ignore-file no-console
// Fail CI when a public export reachable from an entry point has no JSDoc.
// "Public" = any symbol with an `export` declaration in the entry-point graph,
// resolved through re-export barrels — the same surface JSR scores for its
// documentation rating. Covers values AND types. Entry points are read from
// deno.json `exports`, so this script is identical across every @innis package.

interface DocDeclaration {
  readonly declarationKind: string
  readonly jsDoc?: { readonly doc?: string }
}

interface DocSymbol {
  readonly name: string
  readonly declarations: ReadonlyArray<DocDeclaration>
}

interface DocNode {
  readonly symbols?: ReadonlyArray<DocSymbol>
}

interface DocOutput {
  readonly nodes: Record<string, DocNode>
}

const readEntryPoints = async (): Promise<ReadonlyArray<string>> => {
  const config = JSON.parse(await Deno.readTextFile("deno.json"))
  const exports: unknown = config.exports
  if (typeof exports === "string") return [exports]
  if (typeof exports === "object" && exports !== null) {
    return Object.values(exports).filter((value): value is string => typeof value === "string")
  }
  console.error("deno.json has no `exports` field to document.")
  Deno.exit(1)
}

const runDenoDoc = async (entries: ReadonlyArray<string>): Promise<DocOutput> => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", ...entries],
    stdout: "piped",
    stderr: "piped",
  })
  const { code, stdout, stderr } = await cmd.output()
  if (code !== 0) {
    console.error(`deno doc --json failed:\n${new TextDecoder().decode(stderr)}`)
    Deno.exit(1)
  }
  return JSON.parse(new TextDecoder().decode(stdout))
}

const isPublic = (symbol: DocSymbol): boolean =>
  symbol.declarations.some((declaration) => declaration.declarationKind === "export")

const isDocumented = (symbol: DocSymbol): boolean =>
  symbol.declarations.some((declaration) => (declaration.jsDoc?.doc ?? "").trim() !== "")

const entries = await readEntryPoints()
const doc = await runDenoDoc(entries)

const documented = new Map<string, boolean>()
for (const node of Object.values(doc.nodes)) {
  for (const symbol of node.symbols ?? []) {
    if (!isPublic(symbol)) continue
    documented.set(symbol.name, (documented.get(symbol.name) ?? false) || isDocumented(symbol))
  }
}

const undocumented = [...documented.entries()]
  .filter(([, hasDoc]) => !hasDoc)
  .map(([name]) => name)
  .sort()

if (undocumented.length > 0) {
  console.error(`Found ${undocumented.length} undocumented public export(s):`)
  for (const name of undocumented) console.error(`  - ${name}`)
  console.error(`\nEvery public export from ${entries.join(", ")} must have a JSDoc comment.`)
  Deno.exit(1)
}

console.log(`All ${documented.size} public exports have documentation.`)
