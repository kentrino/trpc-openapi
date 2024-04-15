import { FetchHandlerOptions } from '@trpc/server/adapters/fetch';

import { OpenApiRouter } from '../types';
import { ResponseBuilder } from './fetch/ResponseBuilder';
import { createProcedureCache } from './node-http/procedures';

export type CreateOpenApiFetchHandlerOptions<TRouter extends OpenApiRouter> = {
  endpoint: `/${string}`;
  router: FetchHandlerOptions<TRouter>['router'];
  createContext?: FetchHandlerOptions<TRouter>['createContext'];
  responseMeta?: FetchHandlerOptions<TRouter>['responseMeta'];
  onError?: FetchHandlerOptions<TRouter>['onError'];
};

export function createOpenApiFetchHandler<TRouter extends OpenApiRouter>(
  opts: CreateOpenApiFetchHandlerOptions<TRouter>,
): (req: Request) => Promise<Response> {
  const procedureCache = createProcedureCache(opts.router);
  return async function handle(req: Request): Promise<Response> {
    const builder = new ResponseBuilder<TRouter>({
      req: req,
      router: opts.router,
      createContext: opts.createContext,
      procedureCache,
      responseMeta: opts.responseMeta,
      onError: opts.onError,
    });
    return await builder.build();
  };
}
