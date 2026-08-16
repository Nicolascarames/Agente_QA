import type { CrawlInput, CrawlResult, Crawler } from "./crawler.js";

export class FakeCrawler implements Crawler {
  readonly calls: CrawlInput[] = [];

  constructor(private readonly result: CrawlResult) {}

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    this.calls.push(input);
    return this.result;
  }
}
