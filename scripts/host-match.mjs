/**
 * True when `host` is exactly `domain` or a properly delimited subdomain of it.
 * A bare `endsWith(domain)` also accepts unrelated hosts such as `notexample.com`
 * for the domain `example.com`; requiring the leading dot rules that out.
 * `host` must be a hostname without a port (for example `URL.hostname`).
 */
export function hostIsOrIsUnder(host, domain) {
	const normalize = (value) => String(value).toLowerCase().replace(/\.$/, '')
	const h = normalize(host)
	const d = normalize(domain)
	if (!h || !d) return false
	return h === d || h.endsWith(`.${d}`)
}
