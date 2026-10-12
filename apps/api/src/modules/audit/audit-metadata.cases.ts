/** Casos do contrato de metadata, usados no teste unitário e no de paridade com o banco (0005). */
export const METADATA_ACEITO: readonly Record<string, unknown>[] = [
  {},
  { count: 3 },
  { schemaVersion: '1.0', formats: 'json+csv', subscriptionStatus: 'active', tenants: 1, patients: 12 },
  { key_id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' },
  { hash: 'a'.repeat(64) },
  { ok: true, motivo: 'correcao_cadastral', vazio: null },
  { v: 'v1.2.3', n: 9_999_999 }, // poucos dígitos e o maior número aceito
  // Fronteira do tamanho (B2): 16 chaves de 40 caracteres com valores de 17 — passa nos dois lados.
  Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`k${String(i).padStart(2, '0')}${'x'.repeat(37)}`, 'abcdefghijklmnopq']),
  ),
];

export const METADATA_RECUSADO: readonly Record<string, unknown>[] = [
  { x: '123.456.789-09' }, // CPF formatado
  { x: '12345678909' }, // CPF sem máscara
  { x: '898 0012 3456 7890' }, // CNS
  { x: '(11) 98765-4321' }, // telefone
  { x: 'fulano@exemplo.com' }, // e-mail
  { x: 'a'.repeat(65) }, // texto longo
  { antes: 'a' }, // nome de conteúdo
  { Depois: 'b' },
  { diagnostico: 'x' },
  { x: { y: 1 } }, // aninhado
  { x: [1, 2] },
  { x: 12345678909 }, // número grande (CPF como número)
  { x: 987654321 }, // telefone de 9 dígitos como número (B3)
  { x: '987654321' }, // telefone de 9 dígitos como texto (B3)
  { x: '123_456_789/09' }, // CPF com _ e / (B3)
  { x: '123\u00a0456\u00a0789\u00a009' }, // CPF com espaço não separável (NBSP) (B3)
  { x: '11 9 8765 4321' }, // celular com espaços
  { 'chave com espaço': 1 },
  Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])), // chaves demais
];
