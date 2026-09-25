// Stores the SWF viewer's marks in swf-marks.txt, a tab-separated text file meant to be committed.
// Files are identified by the start of their SHA-256 (so marks survive renames) and their path, elements by their id and class name.
// The dev server reads and updates it through /swf-marks (see webpack.config.js).

const fs = require('fs')
const path = require('path')

const file = path.resolve(__dirname, '../swf-marks.txt')

const MARKS = ['impression', 'favorite']

const header = [
    '# SWF viewer marks, edited from swf.html',
    '# impression: I have an impression of it from the game; favorite: I\'ll revisit it',
    '# marks\tsha256\tfile\telement'
]

const collator = new Intl.Collator(undefined, { numeric: true })

function read() {
    let text

    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return []
    }

    return text.split('\n')
        .filter(line => line.trim() && !line.startsWith('#'))
        .map(line => {
            const [marks, hash, source, element = ''] = line.split('\t')
            const [, id, name] = element.match(/^#(\d+) ?(.*)$/) || []

            return {
                marks: marks.split(',').filter(mark => MARKS.includes(mark)),
                hash,
                file: source,
                id: id ? Number(id) : null,
                name: name || null
            }
        })
        .filter(entry => entry.marks.length && entry.hash)
}

function write(entries) {
    const lines = entries
        .sort((a, b) => collator.compare(a.file, b.file) || (a.id ?? -1) - (b.id ?? -1))
        .map(entry => [
            MARKS.filter(mark => entry.marks.includes(mark)).join(','),
            entry.hash,
            entry.file,
            entry.id === null ? '' : `#${entry.id}` + (entry.name ? ` ${entry.name}` : '')
        ].join('\t'))

    fs.writeFileSync(file, [...header, ...lines].join('\n') + '\n')
}

// Sets the marks of a file (id null) or one of its elements; no marks removes the entry
function update({ hash, file: source, id = null, name = null, marks = [] }) {
    if (!/^[0-9a-f]{16}$/.test(hash) || typeof source !== 'string' || !source) {
        throw new Error('Invalid mark')
    }

    const entries = read().filter(entry => !(entry.hash === hash && entry.id === id))

    marks = MARKS.filter(mark => marks.includes(mark))

    if (marks.length) {
        entries.push({ marks, hash, file: source, id, name })
    }

    // Keep every entry of a renamed file under its current path
    entries.forEach(entry => {
        if (entry.hash === hash) entry.file = source
    })

    write(entries)

    return entries
}

module.exports = { read, update }
