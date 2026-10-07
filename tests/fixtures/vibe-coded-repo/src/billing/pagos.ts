export function cobrar(monto: number): number {
  return monto * 1.16
}

export function reembolsar(monto: number): number {
  return -monto
}
