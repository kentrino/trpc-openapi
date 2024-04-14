import { FetchHandlerOptions } from '@trpc/server/adapters/fetch';

import { OpenApiRouter } from '../types';
import { ResponseBuilder } from './fetch/ResponseBuilder';
import { createProcedureCache } from './node-http/procedures';

export type CreateOpenApiFetchHandlerOptions<TRouter extends OpenApiRouter> = Omit<
  FetchHandlerOptions<TRouter>,
  'batching'
> & {
  req: Request;
  endpoint: `/${string}`;
};

export function createOpenApiFetchHandler<TRouter extends OpenApiRouter>(
  opts: Omit<CreateOpenApiFetchHandlerOptions<TRouter>, 'req'>,
): (req: Request) => Promise<Response> {
  const procedureCache = createProcedureCache(opts.router);
  return async function handle(req: Request): Promise<Response> {
    const builder = new ResponseBuilder({
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
