import { DiagnosticEvent, DIAGNOSTIC_HISTORY_LIMIT, isSafeToken, Issue, MAX_READINGS_PER_EVENT } from './snapshot';

/**
 * Human-readable diagnostics report rendering. Inputs are already
 * allowlisted by the issue store; this module only formats them. Issue
 * codes, error names, numeric codes/readings, markers, timestamps, and
 * coarse engine info may appear; usernames, URLs/IPs, tokens, messages, and
 * stacks may not.
 */

/** Header line for exported diagnostics. */
export const DIAGNOSTICS_HEADER = 'Project Panopticon diagnostics';

const LOCAL_ONLY_NOTE = 'Local-only debug information. Nothing here is collected or uploaded.';

function toIso(timestamp: number): string {
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'unknown-time';
}

/** Everything `formatDiagnosticsReport` needs; already allowlisted. */
export interface DiagnosticsReportInput {
    readonly generatedAt: number;
    readonly engineFamily: string;
    readonly activeIssues: readonly Issue[];
    readonly diagnostics: readonly DiagnosticEvent[];
    readonly totalIncidentCount: number;
    readonly retiredIncidentCount: number;
}

/** Renders a human-readable diagnostics report from allowlisted fields only. */
export function formatDiagnosticsReport(input: DiagnosticsReportInput): string {
    const lines: string[] = [
        DIAGNOSTICS_HEADER,
        LOCAL_ONLY_NOTE,
        `Generated: ${toIso(input.generatedAt)}`,
        `Engine: ${input.engineFamily}`,
        '',
        `Active issues (${String(input.activeIssues.length)}, ${String(input.retiredIncidentCount)} retired, ${String(input.totalIncidentCount)} total incidents):`,
    ];

    if (input.activeIssues.length === 0) {
        lines.push('  (none)');
    }
    for (const issue of input.activeIssues) {
        const parts = [
            `${issue.id} code=${issue.code}`,
            `severity=${issue.severity}`,
            `blocking=${issue.blocking ? 'yes' : 'no'}`,
            `occurrences=${String(issue.occurrences)}`,
            `first=${toIso(issue.firstSeen)}`,
            `last=${toIso(issue.lastSeen)}`,
        ];
        if (issue.mediaId !== undefined && isSafeToken(issue.mediaId)) {
            parts.push(`media=${issue.mediaId}`);
        }
        if (issue.mediaErrorCode !== undefined) {
            parts.push(`mediaErrorCode=${String(issue.mediaErrorCode)}`);
        }
        lines.push(`  - ${parts.join(' ')}`);
    }

    lines.push('');
    lines.push(`Diagnostic history (${String(input.diagnostics.length)}/${String(DIAGNOSTIC_HISTORY_LIMIT)} entries):`);
    if (input.diagnostics.length === 0) {
        lines.push('  (none)');
    }
    for (const event of input.diagnostics) {
        const parts = [toIso(event.at), event.type];
        if (event.extensionOrigin === true) {
            parts.push('origin=EXTENSION_ORIGIN');
        }
        if (event.errorName !== undefined) {
            parts.push(`name=${event.errorName}`);
        }
        if (event.mediaErrorCode !== undefined) {
            parts.push(`mediaErrorCode=${String(event.mediaErrorCode)}`);
        }
        if (event.readings !== undefined) {
            for (const [key, value] of Object.entries(event.readings).slice(0, MAX_READINGS_PER_EVENT)) {
                if (isSafeToken(key)) {
                    parts.push(`${key}=${String(value)}`);
                }
            }
        }
        lines.push(`  - ${parts.join(' ')}`);
    }

    return lines.join('\n');
}
