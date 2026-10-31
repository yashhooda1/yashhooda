// lib/docshield/sarif.js — SARIF 2.1.0 output so findings land in GitHub code
// scanning, Azure DevOps or any SARIF viewer alongside SAST results.
import { RULES } from './rules.js';

const LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
const SECURITY_SEVERITY = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0', info: '0.0' };
const HELP = 'https://github.com/yashhooda1/yashhooda/blob/main/docshield/README.md#detections';

/** @param {Array<{report: object, uri?: string}>|object} reports */
export function toSarif(reports, { version = '1.0.0' } = {}) {
  const list = Array.isArray(reports) ? reports : [{ report: reports }];
  const used = new Set(list.flatMap(r => r.report.findings.map(f => f.rule)));
  const ruleIds = Object.keys(RULES).filter(id => used.has(id));
  const rules = ruleIds.map(id => {
    const r = RULES[id];
    const tags = ['security', r.category, ...(r.owasp || []), ...(r.attack || []), ...(r.atlas || []), ...(r.cwe || [])];
    return {
      id, name: r.title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(''),
      shortDescription: { text: r.title },
      helpUri: `${HELP}`,
      defaultConfiguration: { level: LEVEL[r.severity] },
      properties: { tags, 'security-severity': SECURITY_SEVERITY[r.severity] },
    };
  });
  const results = list.flatMap(({ report, uri }) => report.findings.map(f => ({
    ruleId: f.rule,
    ruleIndex: ruleIds.indexOf(f.rule),
    level: LEVEL[f.severity],
    message: { text: `${f.title}: ${f.detail}${f.evidence ? ` Evidence: ${f.evidence}` : ''}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: uri || report.file?.name || 'document' }, region: { startLine: f.line || 1 } } }],
    partialFingerprints: { 'docshield/v1': `${report.file?.sha256?.slice(0, 16) || ''}:${f.rule}:${f.source}` },
    properties: { severity: f.severity, source: f.source, verdict: report.verdict, score: report.score },
  })));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'DocShield', semanticVersion: version, informationUri: 'https://yashhooda.ai/#docshield', rules } },
      results,
    }],
  };
}
