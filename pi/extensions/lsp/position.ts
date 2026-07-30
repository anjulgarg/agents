/**
 * Optional symbol name resolves a missing column when unambiguous on the requested line.
 */

const IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * Resolve one-based column from an optional symbol on a 1-based line.
 * Returns the given column when provided; otherwise finds a unique identifier match.
 */
export function resolveColumn(
	fileContent: string,
	line: number,
	column: number | undefined,
	symbol: string | undefined,
): { column: number; note?: string } {
	if (column !== undefined && column !== null && Number.isFinite(column) && column >= 1) {
		return { column: Math.floor(column) };
	}
	if (!symbol) {
		throw new Error(
			"Column is required unless an unambiguous symbol name is provided for the line",
		);
	}

	const lines = fileContent.split(/\r?\n/);
	const lineText = lines[line - 1];
	if (lineText === undefined) {
		throw new Error(`Line ${line} is out of range`);
	}

	const matches: number[] = [];
	IDENT.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = IDENT.exec(lineText)) !== null) {
		if (match[0] === symbol) {
			matches.push(match.index + 1);
		}
	}

	if (matches.length === 0) {
		throw new Error(`Symbol ${JSON.stringify(symbol)} not found on line ${line}`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Symbol ${JSON.stringify(symbol)} is ambiguous on line ${line} ` +
				`(${matches.length} matches at columns ${matches.join(", ")}); provide column`,
		);
	}
	return {
		column: matches[0]!,
		note: `resolved column ${matches[0]} from symbol ${JSON.stringify(symbol)}`,
	};
}
