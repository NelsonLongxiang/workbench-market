// 上传文件名的统一规则：台文件的每个上传入口（base64、上传票、REST 原始字节、两个 multipart）、工作项附件、SOP 运行文件都用这一条；
// 技能包里的路径、台与 SOP 源码发布的路径按 / 分段，每一段也用这一条。
// 拒：空名、超 255 字符、. 和 ..、路径分隔符、C0 控制字符和 DEL、方向控制符（U+202A～202E、U+2066～2069、U+200E/200F、U+061C）。
// 方向控制符能让名字倒着显示（U+202E 把「txt.exe」显示成「exe.txt」），冒充别的扩展名。
const BAD_CHAR = /[\/\\\x00-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export const UPLOAD_NAME_INVALID = '文件名不合法（≤255 字符，不含路径分隔符与控制字符）';

export function uploadNameOk(name: string): boolean {
  return !!name && name.length <= 255 && name !== '.' && name !== '..' && !BAD_CHAR.test(name);
}
