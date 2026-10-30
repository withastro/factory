/**
 * Tier 0 of the PR safety check: deterministic signals over a pull request's
 * unified diff. No model is involved; these are rules a human reviewer would
 * want pointed out on any untrusted contribution, because each one is a known
 * way to attack a repository, its CI, its maintainers, or its users.
 *
 * A signal is not a verdict. Most legitimate pull requests raise a few (a new
 * `fetch` call, a new URL in docs). The signals are handed to the model as
 * starting points, and recorded alongside its verdict so a maintainer can see
 * what the rules saw independently of what the model concluded.
 */

export type SignalSeverity = 'high' | 'medium' | 'info';

export interface Signal {
	rule: string;
	severity: SignalSeverity;
	detail: string;
	/** Absent for signals about the pull request's own text. */
	path?: string;
	/** Line in the new file (added lines) or old file (removed lines). */
	line?: number;
	/** The offending line, truncated, with invisible characters made visible. */
	excerpt?: string;
	/** How many times the rule matched for this path (or host). */
	occurrences: number;
}

export interface SignalReport {
	signals: Signal[];
	totals: Record<SignalSeverity, number>;
	files: number;
	addedLines: number;
	removedLines: number;
	/** True when signals beyond {@link MAX_SIGNALS} were dropped. */
	truncated: boolean;
}

export interface DiffLine {
	line: number;
	text: string;
}

export interface DiffFile {
	path: string;
	oldPath?: string;
	status: 'added' | 'deleted' | 'modified' | 'renamed';
	binary: boolean;
	added: DiffLine[];
	removed: DiffLine[];
}

export const MAX_SIGNALS = 400;
const MAX_EXCERPT = 200;
const SEVERITY_ORDER: Record<SignalSeverity, number> = {
	high: 0,
	medium: 1,
	info: 2,
};

// ---------------------------------------------------------------------------
// Diff parsing

/** Parse `git diff` output (without `--binary`) into per-file changes. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | undefined;
	let inHunk = false;
	let oldLine = 0;
	let newLine = 0;

	for (const raw of diff.split('\n')) {
		if (raw.startsWith('diff --git ')) {
			file = {
				path: headerPath(raw.slice('diff --git '.length)),
				status: 'modified',
				binary: false,
				added: [],
				removed: [],
			};
			files.push(file);
			inHunk = false;
			continue;
		}
		if (!file) continue;

		if (inHunk) {
			const marker = raw[0];
			if (marker === '+') {
				file.added.push({ line: newLine, text: raw.slice(1) });
				newLine += 1;
				continue;
			}
			if (marker === '-') {
				file.removed.push({ line: oldLine, text: raw.slice(1) });
				oldLine += 1;
				continue;
			}
			if (marker === ' ') {
				oldLine += 1;
				newLine += 1;
				continue;
			}
			if (marker === '\\' || raw === '') continue;
			inHunk = false;
		}

		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (raw.startsWith('new file mode')) file.status = 'added';
		else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
		else if (raw.startsWith('rename from ')) {
			file.oldPath = unquote(raw.slice('rename from '.length));
			file.status = 'renamed';
		} else if (raw.startsWith('rename to ')) {
			file.path = unquote(raw.slice('rename to '.length));
		} else if (raw.startsWith('+++ ')) {
			const path = raw.slice(4);
			if (path !== '/dev/null') file.path = stripPrefix(unquote(path), 'b/');
		} else if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') {
			file.binary = true;
		}
	}
	return files;
}

function headerPath(rest: string): string {
	if (rest.startsWith('"')) {
		const end = rest.indexOf('" ');
		return stripPrefix(unquote(rest.slice(0, end + 1)), 'a/');
	}
	// `a/<path> b/<path>`: the two halves are equal unless the file moved,
	// and moves are corrected by `rename to` / `+++` below.
	const length = (rest.length - 5) / 2;
	if (Number.isInteger(length) && length > 0) {
		const path = rest.slice(2, 2 + length);
		if (rest === `a/${path} b/${path}`) return path;
	}
	const separator = rest.indexOf(' b/');
	return stripPrefix(separator > 0 ? rest.slice(0, separator) : rest, 'a/');
}

function stripPrefix(value: string, prefix: string): string {
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Undo git's C-style quoting of unusual paths. */
function unquote(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) return value;
	const body = value.slice(1, -1);
	const bytes: number[] = [];
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index] as string;
		if (char !== '\\') {
			bytes.push(...new TextEncoder().encode(char));
			continue;
		}
		const next = body[index + 1] ?? '';
		if (/[0-7]/.test(next)) {
			bytes.push(Number.parseInt(body.slice(index + 1, index + 4), 8));
			index += 3;
			continue;
		}
		const escapes: Record<string, string> = {
			n: '\n',
			t: '\t',
			'"': '"',
			'\\': '\\',
			a: '\x07',
			b: '\b',
			f: '\f',
			r: '\r',
			v: '\v',
		};
		bytes.push(...new TextEncoder().encode(escapes[next] ?? next));
		index += 1;
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------
// Path classification

const WORKFLOW_PATH =
	/^\.github\/workflows\/|^\.github\/actions\/|(^|\/)action\.ya?ml$/;
const LOCKFILE_PATH =
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/;
const PACKAGE_JSON_PATH = /(^|\/)package\.json$/;
const DOC_PATH = /\.(md|mdx|markdown|txt|rst)$/i;
const TEST_PATH =
	/(^|\/)(__tests__|__snapshots__|tests?|fixtures?|e2e|spec|mocks?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const DATA_PATH = /\.(svg|snap|map|json|css|min\.js)$/i;

export function isWorkflowPath(path: string): boolean {
	return WORKFLOW_PATH.test(path);
}
export function isLockfilePath(path: string): boolean {
	return LOCKFILE_PATH.test(path);
}
function isDocPath(path: string): boolean {
	return DOC_PATH.test(path) || path.startsWith('.changeset/');
}
function isTestPath(path: string): boolean {
	return TEST_PATH.test(path);
}

interface FileRule {
	rule: string;
	severity: SignalSeverity;
	test: RegExp;
	detail: string;
}

const FILE_RULES: FileRule[] = [
	{
		rule: 'ci-workflow',
		severity: 'high',
		test: WORKFLOW_PATH,
		detail:
			'Changes a GitHub Actions workflow or action, which runs with repository credentials.',
	},
	{
		rule: 'package-manager-config',
		severity: 'high',
		test: /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pnpmfile\.c?js|\.pnpmfile\.mjs|bunfig\.toml)$/,
		detail:
			'Changes package manager configuration that can redirect registries or run code during install.',
	},
	{
		rule: 'git-submodule',
		severity: 'high',
		test: /(^|\/)\.gitmodules$/,
		detail: 'Adds or changes a git submodule source.',
	},
	{
		rule: 'workspace-config',
		severity: 'medium',
		test: /(^|\/)pnpm-workspace\.yaml$/,
		detail:
			'Changes pnpm workspace settings (build-script allowlists, overrides, catalogs).',
	},
	{
		rule: 'dependency-patch',
		severity: 'medium',
		test: /(^|\/)(patches|\.yarn\/patches)\//,
		detail: 'Adds or changes a patch applied to an installed dependency.',
	},
	{
		rule: 'repository-governance',
		severity: 'medium',
		test: /(^|\/)CODEOWNERS$|^\.github\/(dependabot\.ya?ml|factory\.ya?ml|renovate\.json5?)$|(^|\/)(renovate\.json5?|\.renovaterc(\.json5?)?)$/,
		detail:
			'Changes code ownership, dependency automation, or Factory configuration.',
	},
	{
		rule: 'git-hooks',
		severity: 'medium',
		test: /^\.husky\/|^\.githooks\/|(^|\/)(lefthook\.ya?ml|\.simple-git-hooks(\.c?js|\.json)?|\.lintstagedrc(\.\w+)?|\.gitattributes)$/,
		detail:
			'Changes git hooks or attributes that run or transform code on maintainers’ machines.',
	},
	{
		rule: 'editor-config',
		severity: 'medium',
		test: /^\.vscode\/(tasks|settings|launch)\.json$|^\.devcontainer\/|^\.idea\//,
		detail:
			'Changes editor or devcontainer configuration that can run commands when a maintainer opens the repository.',
	},
	{
		rule: 'agent-instructions',
		severity: 'medium',
		test: /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$|^\.(agents|claude|cursor|codex|windsurf)\/|(^|\/)\.cursorrules$|^\.github\/(copilot-instructions\.md|instructions\/|prompts\/)|(^|\/)SKILL\.md$/i,
		detail: 'Changes instructions read by AI coding or review agents.',
	},
	{
		rule: 'github-config',
		severity: 'info',
		test: /^\.github\//,
		detail: 'Changes other repository configuration under .github/.',
	},
];

const BENIGN_BINARY =
	/\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|pdf)$/i;
const EXECUTABLE_BINARY =
	/\.(node|wasm|exe|dll|so|dylib|bin|tgz|tar|gz|zip|7z|rar|jar|whl|deb|rpm|dmg|pkg|msi|appimage|sh)$/i;

// ---------------------------------------------------------------------------
// Line rules

interface LineRule {
	rule: string;
	severity: SignalSeverity;
	detail: string;
	pattern: RegExp;
	/** Restrict the rule to some files. Default: every non-lockfile. */
	appliesTo?: (path: string) => boolean;
	/** Downgrade in tests and docs, where the pattern is routine. */
	relax?: boolean;
	/** Key signals by the matched value (e.g. a host) instead of by path. */
	keyByMatch?: boolean;
	/** Return the matched value, or undefined to skip this line. */
	match?: (text: string, path: string) => string | undefined;
}

const notLockfile = (path: string) => !isLockfilePath(path);

/** Hosts that appear routinely in a JavaScript framework's source and docs. */
const ALLOWED_HOSTS = [
	'github.com',
	'docs.github.com',
	'astro.build',
	'npmjs.com',
	'npmjs.org',
	'nodejs.org',
	'developer.mozilla.org',
	'w3.org',
	'whatwg.org',
	'schema.org',
	'json-schema.org',
	'schemastore.org',
	'example.com',
	'example.org',
	'example.net',
	'localhost',
	'127.0.0.1',
	'0.0.0.0',
	'vite.dev',
	'vitejs.dev',
	'typescriptlang.org',
	'tc39.es',
	'unicode.org',
	'ietf.org',
	'rfc-editor.org',
	'semver.org',
	'shields.io',
	'opencollective.com',
];
const RESERVED_TLDS = ['.test', '.example', '.invalid', '.localhost', '.local'];
const REGISTRY_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
const URL_PATTERN = /\b(?:https?|wss?):\/\/([^\s/"'`<>)\]}\\,;:?#]+)/gi;

export function isAllowedHost(host: string): boolean {
	const normalized = host.toLowerCase().replace(/\.$/, '');
	if (RESERVED_TLDS.some((tld) => normalized.endsWith(tld))) return true;
	return ALLOWED_HOSTS.some(
		(allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`),
	);
}

function firstUnlistedHost(
	text: string,
	allowed: (host: string) => boolean,
): string | undefined {
	for (const match of text.matchAll(URL_PATTERN)) {
		const host = (match[1] ?? '').toLowerCase();
		// Template placeholders (`https://${host}`) are not hosts.
		if (!host || /[${}]/.test(host) || !host.includes('.')) continue;
		if (!allowed(host)) return host;
	}
	return undefined;
}

const PACKAGE_METADATA_KEYS = new Set([
	'homepage',
	'url',
	'repository',
	'bugs',
	'funding',
	'$schema',
	'author',
	'email',
	'web',
	'directory',
	'type',
	'license',
	'description',
]);

const ADDED_LINE_RULES: LineRule[] = [
	// Unicode that hides or reorders code (Trojan Source, GlassWorm).
	{
		rule: 'bidi-control-character',
		severity: 'high',
		detail:
			'Contains a bidirectional control character that can make code render differently from how it runs.',
		pattern: /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/,
		appliesTo: () => true,
	},
	{
		rule: 'invisible-unicode',
		severity: 'high',
		detail:
			'Contains Unicode tag or variation-selector characters, which can encode hidden payloads or instructions.',
		// biome-ignore lint/suspicious/noMisleadingCharacterClass: variation selectors are exactly what this matches.
		pattern: /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u,
		appliesTo: () => true,
	},
	{
		rule: 'zero-width-character',
		severity: 'medium',
		detail: 'Contains a zero-width or invisible filler character.',
		pattern:
			/[\u200B-\u200D\u2060-\u2064\u00AD\u180E\u3164\u115F\u1160\uFFA0\uFEFF]/,
	},
	{
		rule: 'mixed-script-word',
		severity: 'medium',
		detail:
			'A single word mixes Latin with Greek or Cyrillic letters, a common homoglyph trick.',
		pattern:
			/[A-Za-z][\u0370-\u03FF\u0400-\u04FF]|[\u0370-\u03FF\u0400-\u04FF][A-Za-z]/,
	},

	// GitHub Actions.
	{
		rule: 'workflow-privileged-trigger',
		severity: 'high',
		detail:
			'Uses pull_request_target or workflow_run, which run untrusted code with repository secrets if misused.',
		pattern: /\b(pull_request_target|workflow_run)\b/,
		appliesTo: isWorkflowPath,
	},
	{
		rule: 'workflow-expression-injection',
		severity: 'high',
		detail:
			'Interpolates attacker-controlled event data into a workflow, a script-injection risk.',
		pattern:
			/\$\{\{\s*github\.(event\.(pull_request|issue|comment|review|review_comment|discussion|head_commit|commits|pages|workflow_run)\b|head_ref\b)/,
		appliesTo: isWorkflowPath,
	},
	{
		rule: 'workflow-secrets',
		severity: 'medium',
		detail: 'References repository secrets in a workflow.',
		pattern: /\$\{\{\s*secrets\.|secrets\s*:\s*inherit/,
		appliesTo: isWorkflowPath,
	},
	{
		rule: 'workflow-permissions',
		severity: 'medium',
		detail: 'Changes workflow token permissions.',
		pattern: /\bpermissions\s*:|:\s*write\b|\bwrite-all\b/,
		appliesTo: isWorkflowPath,
	},

	// Manifests.
	{
		rule: 'install-script',
		severity: 'high',
		detail: 'Adds a package lifecycle script that runs on install.',
		pattern:
			/"(preinstall|install|postinstall|preuninstall|uninstall|postuninstall)"\s*:/,
		appliesTo: (path) => PACKAGE_JSON_PATH.test(path),
	},
	{
		rule: 'prepare-script',
		severity: 'medium',
		detail: 'Adds a package lifecycle script that runs on prepare or pack.',
		pattern:
			/"(preprepare|prepare|postprepare|prepublish|prepack|postpack)"\s*:/,
		appliesTo: (path) => PACKAGE_JSON_PATH.test(path),
	},
	{
		rule: 'dependency-source',
		severity: 'high',
		detail:
			'Declares a dependency from a git, URL, or file source instead of the registry.',
		pattern: /./,
		appliesTo: (path) => PACKAGE_JSON_PATH.test(path),
		match: (text) => {
			const entry =
				/^\s*"([^"]+)"\s*:\s*"((?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:)[^"]*)"/.exec(
					text,
				);
			if (!entry || PACKAGE_METADATA_KEYS.has(entry[1] as string)) return;
			return `${entry[1]}: ${entry[2]}`;
		},
	},
	{
		rule: 'dependency-alias',
		severity: 'medium',
		detail:
			'Aliases a dependency to a differently named package (npm:), which can hide a substitution.',
		pattern: /^\s*"[^"]+"\s*:\s*"npm:/,
		appliesTo: (path) => PACKAGE_JSON_PATH.test(path),
	},

	// Lockfiles.
	{
		rule: 'lockfile-source',
		severity: 'high',
		detail:
			'The lockfile resolves a package from somewhere other than the npm registry.',
		pattern: /./,
		appliesTo: isLockfilePath,
		keyByMatch: true,
		match: (text) => {
			if (
				/\b(git\+|git:\/\/|github:|codeload\.github\.com)|\btype:\s*git\b/.test(
					text,
				)
			) {
				return 'git source';
			}
			return firstUnlistedHost(text, (host) => REGISTRY_HOSTS.has(host));
		},
	},

	// Code behavior.
	{
		rule: 'credential-access',
		severity: 'high',
		detail: 'References credentials, tokens, or credential files.',
		pattern:
			/\b(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_(TOKEN|URL)|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|VERCEL_TOKEN|NETLIFY_AUTH_TOKEN|CLOUDFLARE_API_TOKEN)\b|\.ssh\/|\bid_(rsa|ed25519|ecdsa)\b|\.git-credentials|\.aws\/credentials|\.docker\/config\.json|\.kube\/config|(?<![\w-])\.npmrc\b/,
		relax: true,
	},
	{
		rule: 'environment-enumeration',
		severity: 'medium',
		detail: 'Reads or serializes the whole process environment.',
		pattern:
			/(Object\.(keys|entries|values)|JSON\.stringify)\(\s*process\.env\b|\.\.\.\s*process\.env\b|\bprocess\.env\s*[,)}\]]/,
		relax: true,
	},
	{
		rule: 'process-execution',
		severity: 'medium',
		detail: 'Spawns a child process.',
		pattern:
			/\bchild_process\b|\b(execSync|spawnSync|execFileSync|execFile|execa|spawn)\s*\(|\bBun\.spawn|\bDeno\.(run|Command)\b/,
		relax: true,
	},
	{
		rule: 'dynamic-code',
		severity: 'medium',
		detail: 'Evaluates code built at runtime.',
		pattern:
			/\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(runIn\w+|Script|compileFunction)\b|\bWebAssembly\.(instantiate|compile)\b/,
		relax: true,
	},
	{
		rule: 'remote-code',
		severity: 'high',
		detail: 'Imports or executes code fetched from a remote URL.',
		pattern:
			/\bimport\s*\(\s*['"`](https?:|data:)|\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b|\bnpx\s+(-y\s+)?https?:/,
	},
	{
		rule: 'network-call',
		severity: 'medium',
		detail: 'Makes a network request.',
		pattern:
			/\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\s*\(|\bnew\s+(WebSocket|EventSource)\s*\(|\b(http|https|http2|net|tls|dgram)\.(request|get|connect|createConnection)\s*\(|\bdns\.(lookup|resolve\w*)\s*\(/,
		relax: true,
	},
	{
		rule: 'new-host',
		severity: 'medium',
		detail: 'References a host that does not routinely appear in this project.',
		pattern: /./,
		relax: true,
		keyByMatch: true,
		match: (text) => firstUnlistedHost(text, isAllowedHost),
	},
	{
		rule: 'encoded-payload',
		severity: 'medium',
		detail: 'Contains a long encoded or escaped string that could hide code.',
		pattern:
			/[A-Za-z0-9+/]{200,}={0,2}|(?:\\x[0-9a-fA-F]{2}){8,}|(?:\\u[0-9a-fA-F]{4}){8,}|String\.fromCharCode\s*\((?:\s*\d+\s*,){8,}/,
		relax: true,
	},
	{
		rule: 'minified-line',
		severity: 'medium',
		detail: 'Adds a very long line that is hard to review.',
		pattern: /^.{1000,}$/,
		relax: true,
	},
	{
		rule: 'prompt-injection',
		severity: 'medium',
		detail: 'Contains text addressed to an AI agent.',
		pattern: PROMPT_INJECTION_PATTERN(),
	},
];

const REMOVED_LINE_RULES: LineRule[] = [
	{
		rule: 'security-logic-removed',
		severity: 'medium',
		detail:
			'Removes a line that looks like a security check; confirm it moved rather than disappeared.',
		pattern:
			/\b(escape\w*|sanitiz\w*|csrf|xss|allow[_-]?list|deny[_-]?list|block[_-]?list|isSafe\w*|timingSafeEqual|authori[sz]\w*|authenticat\w*|sameSite|httpOnly|Content-Security-Policy|integrity|trustedTypes|isAllowed\w*|validate\w*)\b/i,
		appliesTo: (path) =>
			notLockfile(path) && !isTestPath(path) && !isDocPath(path),
	},
	{
		rule: 'test-removed',
		severity: 'info',
		detail: 'Removes a test case.',
		pattern: /^\s*(it|test|describe)(\.\w+)?\s*\(/,
		appliesTo: isTestPath,
	},
];

function PROMPT_INJECTION_PATTERN(): RegExp {
	return /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|system)\s+(instructions|prompts?|rules|guidelines)\b|\byou\s+are\s+(now\s+)?(an?\s+)?(ai|llm|language model|assistant|claude|gpt|chatgpt|reviewer)\b|\b(system|developer)\s+prompt\b|<\/?(system|assistant|instructions?|im_start|im_end)>|\b(ai|llm)\s+(reviewers?|agents?|assistants?)\b|\b(mark|report|classify)\s+(this|the)\s+(pr|pull request|change)\s+as\s+(safe|clean|benign)\b/i;
}

// ---------------------------------------------------------------------------
// Collection

export interface PullRequestText {
	title: string;
	body: string;
}

export function collectSignals(
	diff: string,
	pullRequest?: PullRequestText,
): SignalReport {
	const files = parseUnifiedDiff(diff);
	const collector = new SignalCollector();

	for (const file of files) {
		const path = file.path;
		for (const rule of FILE_RULES) {
			if (
				rule.test.test(path) ||
				(file.oldPath && rule.test.test(file.oldPath))
			) {
				collector.add(rule.rule, rule.severity, rule.detail, { path });
				break;
			}
		}
		if (file.binary) {
			const severity: SignalSeverity = EXECUTABLE_BINARY.test(path)
				? 'high'
				: BENIGN_BINARY.test(path)
					? 'info'
					: 'medium';
			collector.add(
				'binary-file',
				severity,
				`Adds or changes a binary file (${file.status}).`,
				{ path },
			);
		}
		applyLineRules(collector, ADDED_LINE_RULES, path, file.added);
		applyLineRules(collector, REMOVED_LINE_RULES, path, file.removed);
	}

	if (pullRequest) {
		for (const [field, text] of [
			['title', pullRequest.title],
			['body', pullRequest.body],
		] as const) {
			for (const rule of ADDED_LINE_RULES) {
				if (
					![
						'bidi-control-character',
						'invisible-unicode',
						'zero-width-character',
						'prompt-injection',
					].includes(rule.rule)
				) {
					continue;
				}
				const line = text.split('\n').find((value) => rule.pattern.test(value));
				if (line !== undefined) {
					collector.add(
						rule.rule,
						rule.severity,
						`Pull request ${field}: ${rule.detail}`,
						{ excerpt: line },
					);
				}
			}
		}
	}

	return {
		...collector.report(),
		files: files.length,
		addedLines: files.reduce((sum, file) => sum + file.added.length, 0),
		removedLines: files.reduce((sum, file) => sum + file.removed.length, 0),
	};
}

function applyLineRules(
	collector: SignalCollector,
	rules: LineRule[],
	path: string,
	lines: DiffLine[],
): void {
	const relaxed = isTestPath(path) || isDocPath(path) || DATA_PATH.test(path);
	for (const rule of rules) {
		if (!(rule.appliesTo ?? notLockfile)(path)) continue;
		const severity =
			rule.relax && relaxed ? relax(rule.severity) : rule.severity;
		for (const { line, text } of lines) {
			if (!rule.pattern.test(text)) continue;
			const value = rule.match ? rule.match(text, path) : undefined;
			if (rule.match && value === undefined) continue;
			collector.add(
				rule.rule,
				severity,
				value ? `${rule.detail} (${value})` : rule.detail,
				{ path, line, excerpt: text },
				rule.keyByMatch ? value : undefined,
			);
		}
	}
}

function relax(severity: SignalSeverity): SignalSeverity {
	return severity === 'high' ? 'medium' : 'info';
}

class SignalCollector {
	private readonly byKey = new Map<string, Signal>();

	add(
		rule: string,
		severity: SignalSeverity,
		detail: string,
		location: { path?: string; line?: number; excerpt?: string },
		matchKey?: string,
	): void {
		const key = [rule, matchKey ?? location.path ?? detail].join('\0');
		const existing = this.byKey.get(key);
		if (existing) {
			existing.occurrences += 1;
			if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[existing.severity]) {
				existing.severity = severity;
			}
			return;
		}
		this.byKey.set(key, {
			rule,
			severity,
			detail,
			...(location.path !== undefined ? { path: location.path } : {}),
			...(location.line !== undefined ? { line: location.line } : {}),
			...(location.excerpt !== undefined
				? { excerpt: visibleExcerpt(location.excerpt) }
				: {}),
			occurrences: 1,
		});
	}

	report(): Pick<SignalReport, 'signals' | 'totals' | 'truncated'> {
		const all = [...this.byKey.values()].sort(
			(a, b) =>
				SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
				(a.path ?? '').localeCompare(b.path ?? '') ||
				a.rule.localeCompare(b.rule),
		);
		const totals: Record<SignalSeverity, number> = {
			high: 0,
			medium: 0,
			info: 0,
		};
		for (const signal of all) totals[signal.severity] += 1;
		return {
			signals: all.slice(0, MAX_SIGNALS),
			totals,
			truncated: all.length > MAX_SIGNALS,
		};
	}
}

/**
 * Render a line safely for humans and models: invisible and control
 * characters become `\u{…}` escapes, so the excerpt cannot itself hide
 * anything, and long lines are cut.
 */
export function visibleExcerpt(text: string): string {
	const trimmed = escapeInvisible(text).trim();
	return trimmed.length <= MAX_EXCERPT
		? trimmed
		: `${trimmed.slice(0, MAX_EXCERPT - 1)}…`;
}

/** Replace invisible and control characters with `\u{…}` escapes. */
export function escapeInvisible(text: string): string {
	return text.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this escapes.
		// biome-ignore lint/suspicious/noMisleadingCharacterClass: so are variation selectors.
		/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\u3164\u115F\u1160\uFFA0\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu,
		(char) =>
			`\\u{${(char.codePointAt(0) as number).toString(16).toUpperCase()}}`,
	);
}

/** The most severe signal level present, if any. */
export function highestSeverity(
	report: Pick<SignalReport, 'totals'>,
): SignalSeverity | undefined {
	if (report.totals.high) return 'high';
	if (report.totals.medium) return 'medium';
	if (report.totals.info) return 'info';
}
