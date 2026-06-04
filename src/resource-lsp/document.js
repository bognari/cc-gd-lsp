'use strict';

const REFERENCE_RE = /\b(ExtResource|SubResource)\(\s*"?([0-9A-Za-z_]+)"?\s*\)/gd;

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
    for (const { text, line } of s.bodyLines) {
      REFERENCE_RE.lastIndex = 0;
      let m;
      while ((m = REFERENCE_RE.exec(text)) !== null) {
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
