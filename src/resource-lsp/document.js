'use strict';

const REFERENCE_RE = /\b(ExtResource|SubResource)\(\s*"?([0-9A-Za-z_]+)"?\s*\)/gd;

function isInsideQuotedString(text, index) {
  let inString = false;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; } // skip the escaped char
    if (ch === '"') inString = !inString;
  }
  return inString;
}

function buildDocument(sections) {
  const doc = {
    kind: 'unknown',
    format: null,
    header: null,
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
    editables: [],
    resourceSection: null,
    references: [],
    sections,
  };

  if (sections.length > 0) {
    const first = sections[0];
    doc.header = first;
    if (first.name === 'gd_scene') doc.kind = 'scene';
    else if (first.name === 'gd_resource') doc.kind = 'resource';
    if (first.attributes.format !== undefined) {
      const f = Number.parseInt(first.attributes.format, 10);
      doc.format = Number.isNaN(f) ? null : f;
    }
  }

  for (const s of sections) {
    switch (s.name) {
      case 'ext_resource':
        doc.extResources.push({
          id: s.attributes.id,
          type: s.attributes.type,
          path: s.attributes.path,
          uid: s.attributes.uid,
          section: s,
        });
        break;
      case 'sub_resource':
        doc.subResources.push({ id: s.attributes.id, type: s.attributes.type, section: s });
        break;
      case 'node':
        doc.nodes.push({
          name: s.attributes.name,
          type: s.attributes.type,
          parent: s.attributes.parent,
          section: s,
        });
        break;
      case 'connection':
        doc.connections.push(s);
        break;
      case 'editable':
        doc.editables.push(s);
        break;
      case 'resource':
        doc.resourceSection = s;
        break;
      default:
        break;
    }
    // Inline references appear in node/connection headers (Godot-3 style), never in
    // ext_resource/sub_resource declaration headers — skip those to avoid false positives
    // from path/type values that merely contain the substring "Resource(".
    if (s.name !== 'ext_resource' && s.name !== 'sub_resource') {
      for (const key of Object.keys(s.attributes)) {
        const val = s.attributes[key];
        if (typeof val !== 'string' || val.indexOf('Resource(') === -1) continue;
        const vr = s.attrValueRange[key];
        if (!vr) continue;
        // NOTE: vr points at the raw source value; for the unquoted Godot-3 form
        // (script=ExtResource("1")) the offset math below is exact. Godot never
        // emits the outer-quoted-with-escapes form, so no escape remapping is needed.
        REFERENCE_RE.lastIndex = 0;
        let hm;
        while ((hm = REFERENCE_RE.exec(val)) !== null) {
          const idOffsetInVal = hm.indices[2][0];
          doc.references.push({
            kind: hm[1] === 'ExtResource' ? 'ext' : 'sub',
            id: hm[2],
            range: {
              start: { line: vr.start.line, character: vr.start.character + idOffsetInVal },
              end: { line: vr.start.line, character: vr.start.character + idOffsetInVal + hm[2].length },
            },
          });
        }
      }
    }
    for (const { text, line } of s.bodyLines) {
      if (text.trimStart().startsWith(';')) continue; // skip Godot comment lines
      REFERENCE_RE.lastIndex = 0;
      let m;
      while ((m = REFERENCE_RE.exec(text)) !== null) {
        if (isInsideQuotedString(text, m.index)) continue; // literal text inside a string, not a reference
        const [idStart, idEnd] = m.indices[2];
        doc.references.push({
          kind: m[1] === 'ExtResource' ? 'ext' : 'sub',
          id: m[2],
          range: {
            start: { line, character: idStart },
            end: { line, character: idEnd },
          },
        });
      }
    }
  }

  return doc;
}

module.exports = { buildDocument };
