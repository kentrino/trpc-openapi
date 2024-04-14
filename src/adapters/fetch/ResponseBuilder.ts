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
import { ProcedureCache, createProcedureCache } from '../node-http/procedures';

export type ResponseBuilderOptions<TRouter extends OpenApiRouter> = Pick<
  FetchHandlerRequestOptions<TRouter>,
  'router' | 'createContext' | 'responseMeta' | 'onError'
> & { req: Request, procedureCache: ProcedureCache };

export class ResponseBuilder<TRouter extends OpenApiRouter> {
  headers = new Headers();
  ctx: inferRouterContext<TRouter> | undefined;

  constructor(private opts: ResponseBuilderOptions<TRouter>) {
  }

  async build(): Promise<Response> {
    const { router, responseMeta, onError } = this.opts;
    const { procedure, pathInput } = this.opts.procedureCache(this.method, this.path) ?? {};
    if (!procedure || !pathInput) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Not found',
      });
    }
    if (this.method === 'HEAD') {
      return new Response(undefined, {
        status: 204,
        headers: undefined,
      });
    }
    let input: any = undefined;
    let data: any = undefined;
    try {
      const fn = await this.procedureFnFor(procedure.path);
      input = await this.input(procedure.procedure, pathInput);
      // TODO: input can be undefined?
      data = await fn(input);
      const meta = this.opts.responseMeta?.({
        type: procedure.type,
        paths: [procedure.path],
        ctx: this.ctx,
        data: [data as never],
        errors: [],
      });
      const res = new Response(JSON.stringify(data), {
        status: meta?.status ?? 200,
        headers: meta?.headers ?? this.headers,
      });
      res.headers.set('Content-Type', 'application/json');
      return res;
    } catch (cause) {
      const error = getErrorFromUnknown(cause);

      onError?.({
        error,
        type: procedure?.type ?? 'unknown',
        path: procedure?.path,
        input,
        ctx: this.ctx,
        req: this.opts.req,
      });

      const meta = responseMeta?.({
        type: procedure?.type ?? 'unknown',
        paths: procedure?.path ? [procedure?.path] : undefined,
        ctx: this.ctx,
        data: [data],
        errors: [error],
      });
      const errorShape = router.getErrorShape({
        error,
        type: procedure?.type ?? 'unknown',
        path: procedure?.path,
        input,
        ctx: this.ctx,
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
  }

  async procedureFnFor(path: string): Promise<AnyProcedure> {
    const createContext = this.opts.createContext;
    const { req, router } = this.opts;
    // FIXME:
    this.ctx = await createContext?.({ req, resHeaders: this.headers });
    const caller = router.createCaller(this.ctx);
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
    if (!acceptBody) {
      return { ...pathInput };
    }
    if (instanceofZodTypeLikeVoid(schema)) {
      return undefined;
    }
    return {
      ...pathInput,
      ...(await this.requestBody()),
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

  get path(): string {
    const { url: reqUrl } = this.opts.req;
    const url = new URL(reqUrl.startsWith('/') ? `http://127.0.0.1${reqUrl}` : reqUrl);
    return normalizePath(url.pathname);
  }

  async text(): Promise<string> {
    return await this.opts.req.text();
  }

  async requestBody(): Promise<Record<string, unknown> | undefined> {
    const { req } = this.opts;
    try {
      if (req.headers.get('content-type')?.includes('application/json')) {
        // use JSON.parse instead of req.json() because req.json() does not throw on invalid JSON
        return JSON.parse(await this.text());
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
    const data: Record<string, unknown> = {};
    for (const key of params.keys()) {
      data[key] = params.getAll(key);
    }
    return data;
  }
}
