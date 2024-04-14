import { TRPCError } from '@trpc/server';
import { NodeHTTPRequest } from '@trpc/server/dist/adapters/node-http';
import type { IncomingMessage } from 'http';

export const getQuery = (req: NodeHTTPRequest, url: URL): Record<string, string> => {
  const query: Record<string, string> = {};

  if (!req.query) {
    const parsedQs: Record<string, string[]> = {};
    url.searchParams.forEach((value, key) => {
      if (!parsedQs[key]) {
        parsedQs[key] = [];
      }
      parsedQs[key]!.push(value);
    });
    req.query = parsedQs;
  }

  // normalize first value in array
  Object.keys(req.query).forEach((key) => {
    const value = req.query![key];
    if (value) {
      if (typeof value === 'string') {
        query[key] = value;
      } else if (Array.isArray(value)) {
        if (typeof value[0] === 'string') {
          query[key] = value[0];
        }
      }
    }
  });

  return query;
};

const BODY_100_KB = 100000;
export const getBody = async (req: NodeHTTPRequest, maxBodySize = BODY_100_KB): Promise<any> => {
  if ('body' in req) {
    return req.body;
  }

  req.body = undefined;

  const contentType = req.headers['content-type'];
  if (contentType === 'application/json' || contentType === 'application/x-www-form-urlencoded') {
    try {
      const raw = (await getBuffer(req, { limit: maxBodySize })).toString('utf-8');
      const parsed = new URLSearchParams(raw);
      req.body = raw ? parsed : undefined;
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'PayloadTooLargeError') {
        throw new TRPCError({
          message: 'Request body too large',
          code: 'PAYLOAD_TOO_LARGE',
          cause: cause,
        });
      }

      let errorCause: Error | undefined = undefined;
      if (cause instanceof Error) {
        errorCause = cause;
      }

      throw new TRPCError({
        message: 'Failed to parse request body',
        code: 'PARSE_ERROR',
        cause: errorCause,
      });
    }
  }

  return req.body;
};

export function getBuffer(
  incomingMessage: IncomingMessage,
  { limit }: { limit: number } = { limit: 10 * 1000 * 1000 },
) {
  return new Promise<Buffer>((resolve, reject) => {
    const bodyParts: Buffer[] = [];
    let received = 0;
    let body;
    incomingMessage
      .on('data', (chunk) => {
        received += chunk.length;
        if (received > limit) {
          reject(new Error('Body limit exceeded'));
          return;
        }
        bodyParts.push(chunk);
      })
      .on('end', () => {
        body = Buffer.concat(bodyParts);
        resolve(body);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}
