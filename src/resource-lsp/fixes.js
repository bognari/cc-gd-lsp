'use strict';

function distance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

function rangesOverlap(a, b) {
  // true unless a is entirely before b or entirely after b (line+character aware)
  const aBeforeB = a.end.line < b.start.line
    || (a.end.line === b.start.line && a.end.character < b.start.character);
  const bBeforeA = b.end.line < a.start.line
    || (b.end.line === a.start.line && b.end.character < a.start.character);
  return !(aBeforeB || bBeforeA);
}

function replaceAction(title, uri, range, newText) {
  return {
    title,
    kind: 'quickfix',
    edit: { changes: { [uri]: [{ range, newText }] } },
  };
}

function computeCodeActions(doc, diagnostics, selRange, project, uri) {
  const actions = [];

  const claimedExtIds = new Set(doc.extResources.map((x) => x.id).filter(Boolean));
  const claimedSubIds = new Set(doc.subResources.map((x) => x.id).filter(Boolean));

  for (const d of diagnostics) {
    if (!rangesOverlap(d.range, selRange)) continue;

    if (d.code === 'ext-file-missing' && d.data && d.data.suggestions) {
      for (const sug of d.data.suggestions) {
        actions.push(replaceAction(`Replace path with ${sug}`, uri, d.range, sug));
      }
    }

    if (d.code === 'invalid-uid') {
      const ext = doc.extResources.find((e) => e.section.attrValueRange.uid
        && e.section.attrValueRange.uid.start.line === d.range.start.line
        && e.section.attrValueRange.uid.start.character === d.range.start.character);
      if (ext) {
        actions.push(replaceAction('Remove invalid uid attribute', uri, ext.section.attrFullRange.uid, ''));
      }
    }

    if ((d.code === 'undeclared-ext-ref' || d.code === 'undeclared-sub-ref') && d.data) {
      const declared = d.data.declared || [];
      if (declared.length) {
        const best = declared
          .map((id) => ({ id, dist: distance(d.data.id, id) }))
          .sort((a, b) => a.dist - b.dist)[0];
        if (best) actions.push(replaceAction(`Replace with "${best.id}"`, uri, d.range, best.id));
      }
    }

    if (d.code === 'load-steps-mismatch' && d.data && typeof d.data.actual === 'number') {
      actions.push(replaceAction(`Set load_steps to ${d.data.actual}`, uri, d.range, String(d.data.actual)));
    }

    if (d.code === 'duplicate-ext-id' || d.code === 'duplicate-sub-id') {
      const claimed = d.code === 'duplicate-ext-id' ? claimedExtIds : claimedSubIds;
      let n = 1;
      while (claimed.has(String(n))) n++;
      claimed.add(String(n)); // reserve it so a sibling duplicate fix won't reuse it
      actions.push(replaceAction(`Renumber id to "${n}" (body references not updated)`, uri, d.range, String(n)));
    }
  }

  return actions;
}

module.exports = { computeCodeActions };
