import {
  FetchCreateContextFn,
  FetchCreateContextFnOptions,
  FetchHandlerOptions,
} from '@trpc/server/adapters/fetch';
import { AnyRouter, inferRouterContext } from '@trpc/server/src/core';
import { Env, Context as HonoContext } from 'hono';

import { OpenApiRouter } from '../types';
import { ResponseBuilder } from './fetch/ResponseBuilder';
import { createProcedureCache } from './node-http/procedures';

export type CreateOpenApiFetchHandlerOptions<TRouter extends OpenApiRouter, HonoEnv extends Env> = {
  endpoint: `/${string}`;
  router: FetchHandlerOptions<TRouter>['router'];
  createContext?: HonoFetchCreateContextFn<TRouter, HonoEnv>;
  responseMeta?: FetchHandlerOptions<TRouter>['responseMeta'];
  onError?: FetchHandlerOptions<TRouter>['onError'];
};

export type HonoCreateContextFnOptions<HonoEnv extends Env> = FetchCreateContextFnOptions & {
  ctx: HonoContext<HonoEnv>;
};

export type HonoFetchCreateContextFn<TRouter extends AnyRouter, HonoEnv extends Env> = (
  opts: HonoCreateContextFnOptions<HonoEnv>,
) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;

export function createOpenApiFetchHandler<TRouter extends OpenApiRouter, HonoEnv extends Env>(
  opts: CreateOpenApiFetchHandlerOptions<TRouter, HonoEnv>,
): (req: Request, ctx: HonoContext<HonoEnv>) => Promise<Response> {
  const procedureCache = createProcedureCache(opts.router);
  return async function handle(req: Request, ctx: HonoContext<HonoEnv>): Promise<Response> {
    const createContext: FetchCreateContextFn<TRouter> = (contextFnOpts) => {
      // FIXME:
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return opts.createContext?.({
        req: contextFnOpts.req,
        resHeaders: contextFnOpts.resHeaders,
        ctx: ctx,
      });
    };
    const builder = new ResponseBuilder<TRouter>({
      endpoint: opts.endpoint,
      req: req,
      router: opts.router,
      createContext: createContext,
      procedureCache,
      responseMeta: opts.responseMeta,
      onError: opts.onError,
    });
    return await builder.build();
  };
}
