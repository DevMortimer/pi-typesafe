import { TypeSafeIntegrationError } from "./errors.js";

/**
 * How an app names itself in OpenRouter's app attribution (https://openrouter.ai/docs/app-attribution). Sent only to
 * the `openrouter` backend, as request headers that carry no key and no submitted content.
 */
export interface Attribution {
  /** The app's URL, sent as `HTTP-Referer`; OpenRouter identifies the app by it. */
  readonly url: string;
  /** The app's display name in OpenRouter's rankings, sent as `X-OpenRouter-Title`. */
  readonly title?: string;
  /** At most two category slugs, such as `cli-agent` or `ide-extension`, sent as `X-OpenRouter-Categories`. */
  readonly categories?: readonly string[];
  /** True asks OpenRouter to create the app hidden, sent as `X-OpenRouter-App-Visibility: hidden`. An app that already exists keeps its visibility. */
  readonly hidden?: boolean;
}

/** What a client sends when the caller names no app: pi-typesafe itself, which runs inside Pi, a coding agent in the terminal. */
const DEFAULT_ATTRIBUTION: Attribution = { url: "https://github.com/DevMortimer/pi-typesafe", title: "pi-typesafe", categories: ["cli-agent"] };

const FIELDS = new Set(["url", "title", "categories", "hidden"]);
const MAX_CATEGORIES = 2;
const SHAPE_MESSAGE = "attribution must be an object with only url, title, categories, and hidden.";
const URL_MESSAGE = "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment.";
const TITLE_MESSAGE = "Attribution title must be a nonempty string of at most 60 printable ASCII characters.";
const CATEGORIES_MESSAGE = `Attribution categories must be an array of at most ${MAX_CATEGORIES} lowercase, hyphen-separated slugs of at most 30 characters, such as "cli-agent".`;
const HIDDEN_MESSAGE = "Attribution hidden must be a boolean.";

function refuse(message: string): never {
  throw new TypeSafeIntegrationError("configuration", message);
}

/** A header value must be bytes every transport sends alike; anything outside printable ASCII is refused, not encoded. */
function printable(value: string): boolean {
  return /^[\x20-\x7E]+$/.test(value);
}

/** Origin and path only: user info, a query, or a fragment could carry a secret into a header every request repeats. */
function validUrl(value: string): boolean {
  if (value.length > 200 || !printable(value) || value.includes("?") || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
}

/**
 * The OpenRouter app-attribution headers for `attribution`, or for pi-typesafe when it is omitted. A caller's value
 * replaces the default whole: a field it leaves out is not sent. Messages never quote a caller value, because a URL
 * can carry credentials in its user info.
 */
export function attributionHeaders(attribution: Attribution = DEFAULT_ATTRIBUTION): Record<string, string> {
  if (attribution === null || typeof attribution !== "object" || Array.isArray(attribution)) refuse(SHAPE_MESSAGE);
  if (Object.keys(attribution).some(key => !FIELDS.has(key))) refuse(SHAPE_MESSAGE);
  const { url, title, categories, hidden } = attribution;
  const referer = typeof url === "string" ? url.trim() : "";
  if (!validUrl(referer)) refuse(URL_MESSAGE);
  const name = typeof title === "string" ? title.trim() : undefined;
  if (title !== undefined && (name === undefined || name.length > 60 || !printable(name))) refuse(TITLE_MESSAGE);
  if (categories !== undefined && (!Array.isArray(categories) || categories.length > MAX_CATEGORIES
    || categories.some(slug => typeof slug !== "string" || slug.length > 30 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)))) {
    refuse(CATEGORIES_MESSAGE);
  }
  if (hidden !== undefined && typeof hidden !== "boolean") refuse(HIDDEN_MESSAGE);
  return {
    "HTTP-Referer": referer,
    ...(name === undefined ? {} : { "X-OpenRouter-Title": name }),
    ...(categories === undefined || categories.length === 0 ? {} : { "X-OpenRouter-Categories": categories.join(",") }),
    ...(hidden === true ? { "X-OpenRouter-App-Visibility": "hidden" } : {}),
  };
}
