/// <reference lib="webworker" />
import { extractDocument } from '../agents/extractor';
import type { AgentResult, ExtractedDoc } from '../types';

self.onmessage = async (e: MessageEvent<File>) => {
  const result: AgentResult<ExtractedDoc> = await extractDocument(e.data);
  const transfer = result.success
    ? { doc: result.data, transfer: [] as Transferable[] }
    : { doc: null, transfer: [] };
  self.postMessage(result, transfer.transfer);
};

export {};