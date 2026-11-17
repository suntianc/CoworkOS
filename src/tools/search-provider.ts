/** Provider-neutral sources returned by search. */
export interface WebSource {
  title?: string;
  url: string;
  snippet?: string;
  text?: string;
  date?: string;
}
export interface SearchProvider {
  search(
    query: string,
    numResults: number,
    signal: AbortSignal
  ): Promise<{ sources: WebSource[]; content?: string }>;
  fetch(
    url: string,
    signal: AbortSignal
  ): Promise<{
    url: string;
    title?: string;
    content: string;
    status: number;
    contentType: string;
    truncated: boolean;
    bytes: number;
  }>;
}
