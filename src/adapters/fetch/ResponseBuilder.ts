import { AnyProcedure, TRPCError } from '@trpc/server';
import { FetchHandlerRequestOptions } from '@trpc/server/src/adapters/fetch/fetchRequestHandler';
import { inferRouterContext } from '@trpc/server/src/core/types';
import { ZodError, z } from 'zod';

import { OpenApiErrorResponse, OpenApiMethod, OpenApiProcedure, OpenApiRouter } from '../../types';
import { acceptsRequestBody } from '../../utils/method';
import { normalizePath } from '../../utils/path';
import { getInputOutputParsers } from '../../utils/procedure';
import {
  instanceofZodTypeCoercible,
  instanceofZodTypeLikeVoid,
  instanceofZodTypeObject,
  unwrapZodType,
  zodSupportsCoerce,
} from '../../utils/zod';
import { TRPC_ERROR_CODE_HTTP_STATUS, getErrorFromUnknown } from '../node-http/errors';
import { ProcedureCache } from '../node-http/procedures';

export type ResponseBuilderOptions<TRouter extends OpenApiRouter> = Pick<
  FetchHandlerRequestOptions<TRouter>,
  'router' | 'createContext' | 'responseMeta' | 'onError'
> & { req: Request; procedureCache: ProcedureCache };

export class ResponseBuilder<TRouter extends OpenApiRouter> {
  headers = new Headers();
  errorStatus: {
    input: any;
    output: any;
    ctx: inferRouterContext<TRouter> | undefined;
    procedure?: {
      path: string;
      type: 'query' | 'mutation';
    };
  } = {
    input: undefined,
    output: undefined,
    ctx: undefined,
  };

  constructor(private opts: ResponseBuilderOptions<TRouter>) {}

  async build(): Promise<Response> {
    const { procedure, pathInput } = this.opts.procedureCache(this.method, this.path) ?? {};
    try {
      if (this.method === 'HEAD') {
        return new Response(undefined, {
          status: 204,
          headers: undefined,
        });
      }
      if (!procedure || !pathInput) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Not found',
        });
      }
      const input = await this.input(procedure.procedure, pathInput);
      const ctx = await this.opts.createContext?.({ req: this.opts.req, resHeaders: this.headers });
      const fn = this.procedureFnFor(procedure.path, ctx);
      const output = await fn(input as never);
      this.errorStatus = {
        input,
        output,
        ctx,
        procedure: {
          path: procedure.path,
          type: procedure.type,
        },
      };
      const meta = this.opts.responseMeta?.({
        type: procedure.type,
        paths: [procedure.path],
        ctx: ctx,
        data: [output as never],
        errors: [],
      });
      const res = new Response(JSON.stringify(output), {
        status: meta?.status ?? 200,
        headers: meta?.headers ?? this.headers,
      });
      res.headers.set('Content-Type', 'application/json');
      return res;
    } catch (cause) {
      return this.handleError(cause);
    }
  }

  handleError(cause: unknown): Response {
    const error = getErrorFromUnknown(cause);
    const { router, responseMeta, onError } = this.opts;
    const { procedure, input, output, ctx } = this.errorStatus;
    onError?.({
      error,
      type: procedure?.type ?? 'unknown',
      path: procedure?.path,
      input,
      ctx: ctx,
      req: this.opts.req,
    });

    const meta = responseMeta?.({
      type: procedure?.type ?? 'unknown',
      paths: procedure?.path ? [procedure?.path] : undefined,
      ctx: ctx,
      data: [output],
      errors: [error],
    });
    const errorShape = router.getErrorShape({
      error,
      type: procedure?.type ?? 'unknown',
      path: procedure?.path,
      input,
      ctx: ctx,
    });

    const isInputValidationError =
      error.code === 'BAD_REQUEST' &&
      error.cause instanceof Error &&
      error.cause.name === 'ZodError';

    const statusCode = meta?.status ?? TRPC_ERROR_CODE_HTTP_STATUS[error.code] ?? 500;
    const headers = meta?.headers ?? {};
    const body: OpenApiErrorResponse = {
      message: isInputValidationError
        ? 'Input validation failed'
        : errorShape?.message ?? error.message ?? 'An error occurred',
      code: error.code,
      issues: isInputValidationError ? (error.cause as ZodError).errors : undefined,
    };
    return new Response(JSON.stringify(body), {
      status: statusCode,
      headers: headers,
    });
  }

  procedureFnFor(path: string, ctx: inferRouterContext<TRouter>): AnyProcedure {
    const { router } = this.opts;
    const caller = router.createCaller(ctx);
    const segments = path.split('.');
    const procedureFn = segments.reduce((acc, curr) => acc[curr], caller as any) as AnyProcedure;
    return procedureFn;
  }

  async input(
    procedure: OpenApiProcedure,
    pathInput: Record<string, string>,
  ): Promise<Record<string, any> | undefined> {
    const schema = this.schema(procedure);
    const acceptBody = acceptsRequestBody(this.method);
    if (instanceofZodTypeLikeVoid(schema)) {
      return undefined;
    }
    return {
      ...(acceptBody ? await this.requestBody() : this.query),
      ...pathInput,
    };
  }

  schema(procedure: OpenApiProcedure): z.ZodTypeAny {
    const schema = getInputOutputParsers(procedure).inputParser as z.ZodTypeAny;
    const unwrappedSchema = unwrapZodType(schema, true);
    // if supported, coerce all string values to correct types
    if (zodSupportsCoerce) {
      if (instanceofZodTypeObject(unwrappedSchema)) {
        Object.values(unwrappedSchema.shape).forEach((shapeSchema) => {
          const unwrappedShapeSchema = unwrapZodType(shapeSchema, false);
          if (instanceofZodTypeCoercible(unwrappedShapeSchema)) {
            unwrappedShapeSchema._def.coerce = true;
          }
        });
      }
    }
    return unwrappedSchema;
  }

  get method(): OpenApiMethod & 'HEAD' {
    const { method } = this.opts.req;
    return method as never;
  }

  private _url: URL | undefined;
  get url(): URL {
    if (this._url) {
      return this._url;
    }
    const { url: reqUrl } = this.opts.req;
    const url = new URL(reqUrl.startsWith('/') ? `http://127.0.0.1${reqUrl}` : reqUrl);
    this._url = url;
    return url;
  }

  get path(): string {
    return normalizePath(this.url.pathname);
  }

  get query(): Record<string, string> {
    const res: Record<string, string> = {};
    this.url.searchParams.forEach((value, key) => {
      if (typeof res[key] === 'undefined') {
        res[key] = value;
      }
    });
    return res;
  }

  async text(): Promise<string> {
    return await this.opts.req.text();
  }

  async requestBody(): Promise<Record<string, unknown> | undefined> {
    const { req } = this.opts;
    try {
      if (req.headers.get('content-type')?.includes('application/json')) {
        // use JSON.parse instead of req.json() because req.json() does not throw on invalid JSON
        return JSON.parse(await this.opts.req.text());
      }

      if (req.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
        return await this.urlEncodedBody();
      }
      return req.body as never;
    } catch (err) {
      throw new TRPCError({
        code: 'PARSE_ERROR',
        message: 'Failed to parse request body',
        cause: err,
      });
    }
  }

  async urlEncodedBody(this: { text: () => Promise<string> }) {
    const params = new URLSearchParams(await this.text());
    const res: Record<string, string | string[]> = {};
    params.forEach((value, key) => {
      if (typeof res[key] === 'undefined') {
        res[key] = value;
      } else if (typeof res[key] === 'string') {
        res[key] = [res[key] as string, value];
      } else if (Array.isArray(res[key])) {
        (res[key] as string[]).push(value);
      }
    });
    return res;
  }
}
