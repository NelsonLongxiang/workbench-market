/** Supply synthetic trusted identities only in the isolated areas test. */
import { McpService } from '../../server/src/services/mcp.ts';

if (process.env.NODE_ENV !== 'test') throw new Error('area-access identity fixture is test-only');
const fallback = McpService.prototype.areaAccessPrincipal;
const synthetic = new Map([
  ['fixture-area-guest', 'user:tom'],
  ['fixture-area-lead', 'user:leo'],
]);
McpService.prototype.areaAccessPrincipal = function (id) {
  return synthetic.get(this.sessionFull(id)?.name) ?? fallback.call(this, id);
};
