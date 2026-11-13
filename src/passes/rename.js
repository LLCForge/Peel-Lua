export const meaningless = (n) => /^(l_\d+_|_0x|[Il1_]{4,}$)/.test(n) || n.length <= 2;
