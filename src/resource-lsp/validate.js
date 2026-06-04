'use strict';

const SEVERITY = { ERROR: 1, WARNING: 2, INFO: 3 };
const SOURCE = 'godot-resource';
const MAX_FORMAT = 4;
const UID_RE = /^uid:\/\/[a-y0-8]{1,13}$/;

function mk(range, severity, code, message, data) {
  return { range, severity, code, source: SOURCE, message, ...(data ? { data } : {}) };
}

function attrRange(section, key) {
  return section.attrValueRange[key] || section.headerRange;
}

function validate(doc, project) {
  const diags = [];

  if (doc.sections.length === 0) return diags;
  const first = doc.sections[0];
  if (first.name !== 'gd_scene' && first.name !== 'gd_resource') {
    diags.push(mk(first.nameRange, SEVERITY.ERROR, 'unknown-root-tag',
      `Unrecognized root tag '${first.name}'. Expected 'gd_scene' or 'gd_resource'.`));
  }
  if (first.name === 'gd_resource' && first.attributes.type === undefined) {
    diags.push(mk(first.headerRange, SEVERITY.ERROR, 'resource-missing-type',
      `Missing required 'type' attribute in 'gd_resource' tag.`));
  }

  if (doc.format !== null && doc.format > MAX_FORMAT) {
    diags.push(mk(attrRange(first, 'format'), SEVERITY.ERROR, 'format-too-new',
      `format=${doc.format} is newer than this Godot version supports (max ${MAX_FORMAT}).`));
  }

  for (const s of doc.sections) {
    if (s.attributes.uid !== undefined && !UID_RE.test(s.attributes.uid)) {
      diags.push(mk(attrRange(s, 'uid'), SEVERITY.WARNING, 'invalid-uid',
        `Invalid UID '${s.attributes.uid}'. Godot only generates UIDs using [a-y0-8]; this one will not resolve and Godot falls back to the path.`));
    }
    if (s.name === 'ext_resource') {
      for (const req of ['type', 'path', 'id']) {
        if (s.attributes[req] === undefined) {
          diags.push(mk(s.headerRange, SEVERITY.ERROR, 'ext-missing-attr',
            `Missing required '${req}' attribute in 'ext_resource' tag.`));
        }
      }
    } else if (s.name === 'sub_resource') {
      for (const req of ['type', 'id']) {
        if (s.attributes[req] === undefined) {
          diags.push(mk(s.headerRange, SEVERITY.ERROR, 'sub-missing-attr',
            `Missing required '${req}' attribute in 'sub_resource' tag.`));
        }
      }
    } else if (s.name === 'connection') {
      for (const req of ['signal', 'from', 'to', 'method']) {
        if (s.attributes[req] === undefined) {
          diags.push(mk(s.headerRange, SEVERITY.ERROR, 'connection-missing-attr',
            `Missing required '${req}' field in 'connection' tag.`));
        }
      }
    } else if (s.name === 'editable') {
      if (s.attributes.path === undefined) {
        diags.push(mk(s.headerRange, SEVERITY.ERROR, 'editable-missing-path',
          `Missing required 'path' field in 'editable' tag.`));
      }
    } else if (s.name === 'resource' && doc.kind === 'scene') {
      diags.push(mk(s.nameRange, SEVERITY.ERROR, 'resource-tag-in-scene',
        `Unexpected '[resource]' tag in a scene (.tscn) file.`));
    } else if (s.name === 'node' && doc.kind === 'resource') {
      diags.push(mk(s.nameRange, SEVERITY.ERROR, 'node-tag-in-resource',
        `Unexpected '[node]' tag in a resource (.tres) file.`));
    }
  }

  duplicateIds(doc.extResources, 'duplicate-ext-id', 'ext_resource', diags);
  duplicateIds(doc.subResources, 'duplicate-sub-id', 'sub_resource', diags);

  const extIds = new Set(doc.extResources.map((e) => e.id).filter(Boolean));
  const subIds = new Set(doc.subResources.map((sr) => sr.id).filter(Boolean));
  for (const ref of doc.references) {
    if (ref.kind === 'ext' && !extIds.has(ref.id)) {
      diags.push(mk(ref.range, SEVERITY.ERROR, 'undeclared-ext-ref',
        `ExtResource("${ref.id}") refers to an id not declared in this file.`,
        { id: ref.id, declared: [...extIds] }));
    }
    if (ref.kind === 'sub' && !subIds.has(ref.id)) {
      diags.push(mk(ref.range, SEVERITY.ERROR, 'undeclared-sub-ref',
        `SubResource("${ref.id}") refers to an id not declared in this file.`,
        { id: ref.id, declared: [...subIds] }));
    }
  }

  for (const ext of doc.extResources) {
    if (project.root && ext.path && ext.path.startsWith('res://') && !project.fileExists(ext.path)) {
      const suggestions = project.findSimilarFiles(ext.path, 3);
      const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      diags.push(mk(attrRange(ext.section, 'path'), SEVERITY.ERROR, 'ext-file-missing',
        `Referenced file '${ext.path}' does not exist.${hint}`,
        { resPath: ext.path, suggestions }));
    }
  }

  if (first.attributes.load_steps !== undefined) {
    const declared = Number.parseInt(first.attributes.load_steps, 10);
    const actual = doc.extResources.length + doc.subResources.length + 1; // +1 = the main scene/resource
    if (!Number.isNaN(declared) && declared !== actual) {
      diags.push(mk(attrRange(first, 'load_steps'), SEVERITY.INFO, 'load-steps-mismatch',
        `load_steps=${declared} but should be ${actual} (${doc.extResources.length} ext + ${doc.subResources.length} sub + 1 main). Godot ignores this value, but keeping it correct is conventional.`,
        { actual }));
    }
  }

  return diags;
}

function duplicateIds(list, code, tagName, diags) {
  const seen = new Map();
  for (const item of list) {
    if (!item.id) continue;
    if (seen.has(item.id)) {
      diags.push(mk(item.section.attrValueRange.id || item.section.headerRange, SEVERITY.WARNING, code,
        `Duplicate ${tagName} id '${item.id}'. Each id must be unique within the file.`,
        { id: item.id }));
    } else {
      seen.set(item.id, item);
    }
  }
}

module.exports = { validate, SEVERITY };
