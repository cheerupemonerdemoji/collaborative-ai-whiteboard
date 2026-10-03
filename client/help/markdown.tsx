import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { resolveGuideLink } from './guide'

/**
 * A deliberately small Markdown renderer for the user guide (docs/user-guide/*.md).
 *
 * It handles only the constructs those pages use - headings, paragraphs, bullet and numbered
 * lists, fenced code, tables, block quotes, horizontal rules, and inline code/bold/italic/links -
 * and renders React elements, never raw HTML, so guide text can never inject markup. A link
 * that is neither a guide page nor an https:// address is rendered as plain text.
 */

export type Block =
	| { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string; id: string }
	| { kind: 'paragraph'; text: string }
	| { kind: 'code'; text: string }
	| { kind: 'list'; ordered: boolean; items: string[] }
	| { kind: 'table'; header: string[]; align: ('left' | 'right' | 'center')[]; rows: string[][] }
	| { kind: 'quote'; blocks: Block[] }
	| { kind: 'rule' }

export function slugifyHeading(text: string): string {
	return text.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

function splitTableRow(line: string): string[] {
	let trimmed = line.trim()
	if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
	if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
	return trimmed.split('|').map((cell) => cell.trim())
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

export function parseBlocks(markdown: string): Block[] {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
	const blocks: Block[] = []
	let index = 0
	while (index < lines.length) {
		const line = lines[index]
		if (line.trim() === '') { index += 1; continue }

		if (line.trim().startsWith('```')) {
			const body: string[] = []
			index += 1
			while (index < lines.length && !lines[index].trim().startsWith('```')) { body.push(lines[index]); index += 1 }
			index += 1
			blocks.push({ kind: 'code', text: body.join('\n') })
			continue
		}

		const heading = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line)
		if (heading) {
			const text = heading[2]
			blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4, text, id: slugifyHeading(text) })
			index += 1
			continue
		}

		if (/^-{3,}\s*$/.test(line)) { blocks.push({ kind: 'rule' }); index += 1; continue }

		if (line.trim().startsWith('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes('-')) {
			const header = splitTableRow(line)
			const align = splitTableRow(lines[index + 1]).map((cell) => {
				const left = cell.startsWith(':')
				const right = cell.endsWith(':')
				return left && right ? 'center' as const : right ? 'right' as const : 'left' as const
			})
			const rows: string[][] = []
			index += 2
			while (index < lines.length && lines[index].trim().startsWith('|')) { rows.push(splitTableRow(lines[index])); index += 1 }
			blocks.push({ kind: 'table', header, align, rows })
			continue
		}

		if (line.startsWith('>')) {
			const quoted: string[] = []
			while (index < lines.length && lines[index].startsWith('>')) { quoted.push(lines[index].replace(/^>\s?/, '')); index += 1 }
			blocks.push({ kind: 'quote', blocks: parseBlocks(quoted.join('\n')) })
			continue
		}

		const bullet = /^[-*]\s+(.*)$/.exec(line)
		const numbered = /^\d+\.\s+(.*)$/.exec(line)
		if (bullet || numbered) {
			const ordered = Boolean(numbered)
			const itemPattern = ordered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/
			const items: string[] = []
			while (index < lines.length) {
				const match = itemPattern.exec(lines[index])
				if (!match) break
				const parts = [match[1]]
				index += 1
				// Indented continuation lines belong to the same item.
				while (index < lines.length && /^\s+\S/.test(lines[index]) && !itemPattern.test(lines[index].trim())) { parts.push(lines[index].trim()); index += 1 }
				items.push(parts.join(' '))
				while (index < lines.length && lines[index].trim() === '' && index + 1 < lines.length && itemPattern.test(lines[index + 1])) index += 1
			}
			blocks.push({ kind: 'list', ordered, items })
			continue
		}

		const paragraph: string[] = []
		while (index < lines.length && lines[index].trim() !== '' && !/^(#{1,4}\s|```|>|[-*]\s|\d+\.\s|\|)/.test(lines[index]) && !/^-{3,}\s*$/.test(lines[index])) {
			paragraph.push(lines[index].trim())
			index += 1
		}
		if (paragraph.length === 0) { paragraph.push(line.trim()); index += 1 }
		blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
	}
	return blocks
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*?\*)/

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
	const nodes: ReactNode[] = []
	let rest = text
	let counter = 0
	while (rest.length > 0) {
		const match = INLINE.exec(rest)
		if (!match) { nodes.push(rest); break }
		if (match.index > 0) nodes.push(rest.slice(0, match.index))
		const token = match[0]
		const key = `${keyPrefix}-${counter++}`
		if (match[1]) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
		else if (match[2]) nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>)
		else if (match[3]) {
			const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
			if (link) nodes.push(renderLink(link[1], link[2], key))
			else nodes.push(token)
		} else nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>)
		rest = rest.slice(match.index + token.length)
	}
	return nodes
}

function renderLink(label: string, href: string, key: string): ReactNode {
	const inner = renderInline(label, key)
	const guide = resolveGuideLink(href)
	if (guide) return <Link key={key} to={guide}>{inner}</Link>
	if (/^https:\/\//i.test(href)) return <a key={key} href={href} target="_blank" rel="noopener noreferrer">{inner}</a>
	return <span key={key}>{inner}</span>
}

function renderBlock(block: Block, key: string): ReactNode {
	switch (block.kind) {
		case 'heading': {
			const content = renderInline(block.text, key)
			if (block.level === 1) return <h1 key={key} id={block.id}>{content}</h1>
			if (block.level === 2) return <h2 key={key} id={block.id}>{content}</h2>
			if (block.level === 3) return <h3 key={key} id={block.id}>{content}</h3>
			return <h4 key={key} id={block.id}>{content}</h4>
		}
		case 'paragraph': return <p key={key}>{renderInline(block.text, key)}</p>
		case 'code': return <pre key={key} tabIndex={0}><code>{block.text}</code></pre>
		case 'rule': return <hr key={key} />
		case 'quote': return <blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>
		case 'list': {
			const items = block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)
			return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
		}
		case 'table': return <div key={key} className="aw-help-table-wrap"><table>
			<thead><tr>{block.header.map((cell, c) => <th key={c} style={{ textAlign: block.align[c] }}>{renderInline(cell, `${key}-h${c}`)}</th>)}</tr></thead>
			<tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} style={{ textAlign: block.align[c] }}>{renderInline(cell, `${key}-${r}-${c}`)}</td>)}</tr>)}</tbody>
		</table></div>
	}
}

export function renderBlocks(blocks: Block[], keyPrefix = 'b'): ReactNode[] {
	return blocks.map((block, index) => renderBlock(block, `${keyPrefix}-${index}`))
}

export function Markdown({ source }: { source: string }) {
	return <>{renderBlocks(parseBlocks(source))}</>
}
