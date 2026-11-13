/**
 * 团队归属绑节点的核对条件（只有 SQL 文本，不引任何服务）：services/team.ts 和 services/bench-registry.ts 都从这里引，
 * 免得 bench-registry 为了这一句去引 team.ts（会把整个服务链带进来，先载入 bench-registry 时 TeamService 还没初始化完）。
 *
 * 别名 a 那一行记下的节点（host、peer_root、key_fingerprint）就是现在名册和对端登记里的那个（对端启用、指纹不空），
 * 而且这个号在名册里只对应这一个节点（名册以后按根地址和指纹分开存时，一个号可能对应好几个节点：认不清就不算数）。
 */
export const boundSql = (a: string): string => `(EXISTS (SELECT 1 FROM a2a_rosters br JOIN a2a_peers bp ON bp.root_url = br.peer_root
  WHERE br.host = ${a}.host AND br.peer_root = ${a}.peer_root AND br.peer_root <> '' AND bp.status = 'active' AND bp.key_fingerprint = ${a}.key_fingerprint AND ${a}.key_fingerprint <> '')
  AND (SELECT COUNT(*) FROM a2a_rosters bn WHERE bn.host = ${a}.host) = 1)`;
