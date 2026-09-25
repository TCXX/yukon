// Builds the SWF viewer's file tree by scanning assets/swf.
// The dev server serves it live at assets/swf/swf.json; run `node utils/swf-list.js` to write it to disk for static hosting.

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../assets/swf')

const collator = new Intl.Collator(undefined, { numeric: true })

// "蜜蜂商品册丨catalog_beecatalog" -> "蜜蜂商品册 (beecatalog)", "spriteforest1~0" -> "spriteforest1"
function label(name) {
    const clean = text => text
        .replace(/~\d+$/, '')
        .replace(/^\d{4}-\d{2}-\d{2}_/, '')
        .replace(/^(catalog|task)_/, '')

    if (!name.includes('丨')) {
        return clean(name)
    }

    let [local, english] = name.split('丨', 2)

    // Some names put the English part first, e.g. "login丨岛屿选择"
    if (/^[\x00-\x7f]+$/.test(local) && !/^[\x00-\x7f]+$/.test(english)) {
        [local, english] = [english, local]
    }

    return `${local} (${clean(english)})`
}

function scan(dir = root) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.'))
        .sort((a, b) => collator.compare(a.name, b.name))

    const files = entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.swf'))
        .map(entry => ({
            source: path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'),
            label: label(entry.name.slice(0, -4))
        }))

    const folders = entries
        .filter(entry => entry.isDirectory())
        .map(entry => ({ label: label(entry.name), children: scan(path.join(dir, entry.name)) }))
        .filter(folder => folder.children.length)

    // Files directly in assets/swf get a group of their own, listed after the folders
    if (dir === root) {
        return files.length ? [...folders, { label: 'Other Files', children: files }] : folders
    }

    // Loose files first, then folders
    return [...files, ...folders]
}

module.exports = scan

if (require.main === module) {
    fs.writeFileSync(path.join(root, 'swf.json'), JSON.stringify(scan(), null, 4) + '\n')
}
