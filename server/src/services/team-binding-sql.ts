/**
 * 团队归属绑节点的核对条件（只有 SQL 文本，不引任何服务）：services/team.ts 和 services/bench-registry.ts 都从这里引，
 * 免得 bench-registry 为了这一句去引 team.ts（会把整个服务链带进来，先载入 bench-registry 时 TeamService 还没初始化完）。
 *
 * 别名 a 那一行记下的节点（host、peer_root、key_fingerprint）就是现在按这个号认得出的那个节点：名册视图 a2a_rosters_live 里
 * 这个号的那一行（视图保证一个号最多一行——两个节点报了同一个号就两个都不算；还排除了停用、等确认新键、指纹不是钉住那把的），
 * 根地址、完整指纹都和这一行记的一样，并且对端登记启用、钉住的就是这把（指纹不空）。
 */
export const boundSql = (a: string): string => `(EXISTS (SELECT 1 FROM a2a_rosters_live br JOIN a2a_peers bp ON bp.root_url = br.peer_root
  WHERE br.host = ${a}.host AND br.peer_root = ${a}.peer_root AND br.peer_root <> '' AND br.key_fingerprint = ${a}.key_fingerprint
    AND bp.status = 'active' AND bp.key_fingerprint = ${a}.key_fingerprint AND ${a}.key_fingerprint <> ''))`;
