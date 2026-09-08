import { app } from '../../app';
import serverless from 'serverless-http';

module.exports.handler = serverless(app, {
  request(request: unknown = {}, event: unknown = {}, _context: unknown = {}) {
    const req = request as Record<string, unknown>;
    const evt = event as Record<string, unknown>;

    if (!req.context) {
      req.context = {};
    }
    req.context = evt.requestContext;

    if (evt.requestContext && typeof evt.requestContext === 'object') {
      const requestContext = evt.requestContext as Record<string, unknown>;
      if (requestContext.authorizer) {
        req.claims = (
          requestContext.authorizer as Record<string, unknown>
        ).claims;
      }
    }
  },
});
