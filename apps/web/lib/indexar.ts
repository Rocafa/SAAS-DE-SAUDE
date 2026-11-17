/**
 * Índice por id, para a tela achar o paciente, o profissional ou o tipo de um agendamento sem varrer
 * a lista inteira a cada linha. Era escrito à mão em doze pontos, sempre igual.
 */
export function indexarPorId<T extends { id: string }>(itens: readonly T[]): Map<string, T> {
  return new Map(itens.map((i) => [i.id, i]));
}
