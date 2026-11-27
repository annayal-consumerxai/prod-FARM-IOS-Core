import sharp from 'sharp';

/**
 * Optional client for an icon-detection screen parser service
 * (`POST /v1/parse`, see docs/screen-parser.md). When `SCREEN_PARSER_URL` is
 * unset, nothing here runs and doomscroll keeps its template-matched or
 * profile coordinates.
 */
export interface ScreenParserConfig {
    url: string;
    token?: string;
    timeoutMs: number;
    minConfidence: number;
}

export interface ParsedIcon {
    label: string;
    confidence: number;
    /** Icon centre as a percentage of the screenshot width and height. */
    centerPct: [number, number];
}

export interface IconState {
    x: number;
    y: number;
    /** True when the icon is already in its filled state (liked / saved). */
    active: boolean;
    confidence: number;
}

export interface EngagementState {
    like?: IconState;
    save?: IconState;
}

export interface ScreenSize {
    width: number;
    height: number;
}

type FetchLike = typeof fetch;

// The service rejects bodies over 5 MB. Large-screen PNGs can exceed that,
// so those are re-encoded as JPEG before upload.
const MAX_PNG_BYTES = 4_500_000;
// TikTok's like/save rail sits on the right edge. Ignoring icons left of this
// keeps comment-sheet hearts and caption glyphs out of the match.
const RIGHT_RAIL_MIN_X_PCT = 70;

function numberFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be a number between ${min} and ${max}; received ${raw}`);
    }
    return value;
}

export function screenParserConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ScreenParserConfig | undefined {
    const raw = env.SCREEN_PARSER_URL?.trim();
    if (!raw) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`SCREEN_PARSER_URL must be an http(s) URL; received ${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`SCREEN_PARSER_URL must be an http(s) URL; received ${raw}`);
    }
    const token = env.SCREEN_PARSER_TOKEN?.trim() || undefined;
    return {
        url: parsed.toString().replace(/\/+$/, ''),
        ...(token ? { token } : {}),
        timeoutMs: numberFromEnv(env, 'SCREEN_PARSER_TIMEOUT_MS', 5000, 500, 30_000),
        minConfidence: numberFromEnv(env, 'SCREEN_PARSER_MIN_CONFIDENCE', 0.35, 0.01, 0.99),
    };
}

function authHeaders(config: ScreenParserConfig): Record<string, string> {
    return config.token ? { authorization: `Bearer ${config.token}` } : {};
}

export async function screenParserReady(config: ScreenParserConfig, fetchImpl: FetchLike = fetch): Promise<boolean> {
    try {
        const response = await fetchImpl(`${config.url}/health/ready`, {
            headers: authHeaders(config),
            signal: AbortSignal.timeout(config.timeoutMs),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/** Keeps only well-formed icon entries; anything else in the payload is ignored. */
export function iconsFromResponse(body: unknown): ParsedIcon[] {
    const icons = (body as { icons?: unknown } | null)?.icons;
    if (!Array.isArray(icons)) throw new Error('Screen parser response has no icons array');
    const result: ParsedIcon[] = [];
    for (const entry of icons) {
        const { label, confidence, centerPct } = (entry ?? {}) as Record<string, unknown>;
        if (typeof label !== 'string' || typeof confidence !== 'number' || !Array.isArray(centerPct)) continue;
        const [cx, cy] = centerPct;
        if (typeof cx !== 'number' || typeof cy !== 'number' || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        result.push({ label, confidence, centerPct: [cx, cy] });
    }
    return result;
}

function isPng(image: Buffer): boolean {
    return image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
}

export async function parseScreenIcons(
    config: ScreenParserConfig,
    screenshot: Buffer,
    fetchImpl: FetchLike = fetch,
): Promise<ParsedIcon[]> {
    let body = screenshot;
    let contentType = isPng(screenshot) ? 'image/png' : 'image/jpeg';
    if (contentType === 'image/png' && screenshot.length > MAX_PNG_BYTES) {
        body = await sharp(screenshot).jpeg({ quality: 88 }).toBuffer();
        contentType = 'image/jpeg';
    }
    const response = await fetchImpl(`${config.url}/v1/parse`, {
        method: 'POST',
        headers: { 'content-type': contentType, ...authHeaders(config) },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) throw new Error(`Screen parser returned HTTP ${response.status}`);
    return iconsFromResponse(await response.json());
}

function bestOf(icons: ParsedIcon[], plain: string, filled: string, minConfidence: number): ParsedIcon | undefined {
    let best: ParsedIcon | undefined;
    for (const icon of icons) {
        if (icon.label !== plain && icon.label !== filled) continue;
        if (icon.confidence < minConfidence || icon.centerPct[0] < RIGHT_RAIL_MIN_X_PCT) continue;
        if (!best || icon.confidence > best.confidence) best = icon;
    }
    return best;
}

function toState(icon: ParsedIcon, filled: string, screen: ScreenSize): IconState {
    const clamp = (value: number, max: number) => Math.min(Math.max(Math.round(value), 1), max - 1);
    return {
        x: clamp((icon.centerPct[0] / 100) * screen.width, screen.width),
        y: clamp((icon.centerPct[1] / 100) * screen.height, screen.height),
        active: icon.label === filled,
        confidence: icon.confidence,
    };
}

/** Maps parser output to TikTok like/save targets in device points. */
export function tiktokEngagementState(icons: ParsedIcon[], screen: ScreenSize, minConfidence: number): EngagementState {
    const like = bestOf(icons, 'tt_like', 'tt_liked', minConfidence);
    const save = bestOf(icons, 'tt_save', 'tt_saved', minConfidence);
    return {
        ...(like ? { like: toState(like, 'tt_liked', screen) } : {}),
        ...(save ? { save: toState(save, 'tt_saved', screen) } : {}),
    };
}
