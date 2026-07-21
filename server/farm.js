// wiki-plugin-semindex — farm discovery (CommonJS)
//
// In farm mode each site instance's argv.data is {farmRoot}/{host}, so the
// farm root is one level up and sibling dirs containing pages/ are the other
// sites. In single-site mode (no --farm) the data dir's parent is NOT a farm
// (it could be $HOME) — scope to just this one site.

const fs = require('node:fs')
const path = require('node:path')

// * and ? glob over domain names (no path semantics)
const globMatch = (pattern, str) => {
  const re = new RegExp('^' +
    pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
           .replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return re.test(str)
}

const farmRootOf = argv => path.dirname(path.resolve(argv.data))

// [{root, domain}] — every indexable site this instance should consider.
const listSites = argv => {
  const root = farmRootOf(argv)
  if (!argv.farm) return [{ root, domain: path.basename(path.resolve(argv.data)) }]
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .filter(e => {
      try { return fs.statSync(path.join(root, e.name, 'pages')).isDirectory() } catch { return false }
    })
    .map(e => ({ root, domain: e.name }))
    .sort((a, b) => a.domain.localeCompare(b.domain))
}

const hasNoindex = (root, domain) =>
  fs.existsSync(path.join(root, domain, 'status', 'noindex'))

module.exports = { listSites, farmRootOf, globMatch, hasNoindex }
