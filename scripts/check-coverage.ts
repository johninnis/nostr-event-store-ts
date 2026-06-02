// deno-lint-ignore-file no-console
const LCOV_PATH = "cov_profile/lcov.info"
const FLOOR_PERCENT = 80

const readLcov = async (): Promise<string> => {
  try {
    return await Deno.readTextFile(LCOV_PATH)
  } catch {
    console.error(`No coverage report at ${LCOV_PATH}. Run \`deno task coverage\` first.`)
    Deno.exit(1)
  }
}

const lcov = await readLcov()

let linesFound = 0
let linesHit = 0
for (const line of lcov.split("\n")) {
  if (line.startsWith("LF:")) linesFound += Number(line.slice(3))
  else if (line.startsWith("LH:")) linesHit += Number(line.slice(3))
}

if (linesFound === 0) {
  console.error(`No coverage data in ${LCOV_PATH}. Run \`deno task coverage\` first.`)
  Deno.exit(1)
}

const pct = Math.round((1000 * linesHit) / linesFound) / 10

if (pct < FLOOR_PERCENT) {
  console.error(`Line coverage ${pct}% is below the ${FLOOR_PERCENT}% floor (${linesHit}/${linesFound} lines).`)
  Deno.exit(1)
}

console.log(`Line coverage: ${pct}% (floor ${FLOOR_PERCENT}%, ${linesHit}/${linesFound} lines).`)
