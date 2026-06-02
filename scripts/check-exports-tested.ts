// deno-lint-ignore-file no-console
// Fail CI when a public-exported runtime value (function / class / variable) from
// mod.ts has zero word-boundary references in tests/. Type-only exports
// (interface / typeAlias) are skipped — they have no runtime to exercise.
// `KIND_*` constants are exempt: they're protocol-defined integer literals — any
// "test" would be tautological. Anything else, including string constants and
// regexes with logic, is in scope.

const ENTRY_POINTS = ["mod.ts"]
const TEST_ROOT = "tests"
const VALUE_KINDS: ReadonlySet<string> = new Set(["function", "class", "variable"])
const isExempt = (name: string): boolean => name.startsWith("KIND_")

interface DocDeclaration {
  readonly declarationKind: string
  readonly kind: string
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

const runDenoDoc = async (entry: string): Promise<DocOutput> => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", entry],
    stdout: "piped",
    stderr: "piped",
  })
  const { code, stdout, stderr } = await cmd.output()
  if (code !== 0) {
    console.error(`deno doc --json ${entry} failed:\n${new TextDecoder().decode(stderr)}`)
    Deno.exit(1)
  }
  const parsed: DocOutput = JSON.parse(new TextDecoder().decode(stdout))
  return parsed
}

const collectPublicValueExports = async (): Promise<Set<string>> => {
  const exports = new Set<string>()
  for (const entry of ENTRY_POINTS) {
    const doc = await runDenoDoc(entry)
    for (const node of Object.values(doc.nodes)) {
      for (const sym of node.symbols ?? []) {
        const hasValueExport = sym.declarations.some(
          (d) => d.declarationKind === "export" && VALUE_KINDS.has(d.kind),
        )
        if (hasValueExport) exports.add(sym.name)
      }
    }
  }
  return exports
}

const walkTestFiles = async function* (dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory) yield* walkTestFiles(path)
    else if (entry.isFile && path.endsWith(".test.ts")) yield path
  }
}

const readAllTestContent = async (): Promise<string> => {
  const parts: Array<string> = []
  for await (const path of walkTestFiles(TEST_ROOT)) {
    parts.push(await Deno.readTextFile(path))
  }
  return parts.join("\n")
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const exports = await collectPublicValueExports()
const testContent = await readAllTestContent()

const untested: Array<string> = []
for (const name of exports) {
  if (isExempt(name)) continue
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`)
  if (!pattern.test(testContent)) untested.push(name)
}

if (untested.length > 0) {
  console.error(`Found ${untested.length} public value export(s) with no test reference:`)
  for (const name of untested.sort()) console.error(`  - ${name}`)
  console.error(`\nEvery public runtime export from mod.ts / testing.ts must be referenced by at least one test.`)
  Deno.exit(1)
}

console.log(`All ${exports.size} public value exports are referenced by at least one test.`)
