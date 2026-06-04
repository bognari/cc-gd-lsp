'use strict';

const HEADER_RE = /^\s*\[([A-Za-z_][\w]*)\b([^\]]*)\]\s*$/;

// Parse `key=value` / `key="value"` pairs out of a header's attribute span.
// Returns { attributes, attrValueRange, attrFullRange } with ranges on `line`.
function parseAttributes(attrSpan, spanOffset, line) {
  const attributes = {};
  const attrValueRange = {};
  const attrFullRange = {};
  const re = /([A-Za-z_][\w]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s\]]+)/g;
  let m;
  while ((m = re.exec(attrSpan)) !== null) {
    const key = m[1];
    let rawValue = m[2];
    const valueStartInSpan = m.index + m[0].length - rawValue.length;
    let value = rawValue;
    let valueChar = spanOffset + valueStartInSpan;
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      value = rawValue.slice(1, -1).replace(/\\(.)/g, '$1');
      valueChar += 1; // skip opening quote
    }
    attributes[key] = value;
    attrValueRange[key] = {
      start: { line, character: valueChar },
      end: { line, character: valueChar + value.length },
    };
    const fullStart = spanOffset + m.index;
    attrFullRange[key] = {
      start: { line, character: fullStart },
      end: { line, character: fullStart + m[0].length },
    };
  }
  return { attributes, attrValueRange, attrFullRange };
}

function tokenize(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = HEADER_RE.exec(line);
    if (hm) {
      const name = hm[1];
      const nameStart = line.indexOf(name, line.indexOf('['));
      const attrSpan = hm[2];
      const attrSpanOffset = nameStart + name.length;
      const parsed = parseAttributes(attrSpan, attrSpanOffset, i);
      current = {
        name,
        attributes: parsed.attributes,
        attrValueRange: parsed.attrValueRange,
        attrFullRange: parsed.attrFullRange,
        headerLine: i,
        headerRange: {
          start: { line: i, character: 0 },
          end: { line: i, character: line.length },
        },
        nameRange: {
          start: { line: i, character: nameStart },
          end: { line: i, character: nameStart + name.length },
        },
        bodyLines: [],
      };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push({ text: line, line: i });
    }
  }

  return sections;
}

module.exports = { tokenize };
