import type { InvoiceItem } from '../types/wsfe';

/**
 * Calcula el subtotal de items (sin IVA)
 */
export function calculateSubtotal(items: InvoiceItem[], includesVAT = false): number {
    return items.reduce((sum, item) => {
        let netPrice = item.unitPrice;
        if (includesVAT && item.vatRate) {
            netPrice = item.unitPrice / (1 + (item.vatRate / 100));
        }
        return sum + (item.quantity * netPrice);
    }, 0);
}

/**
 * Calcula el IVA total de items
 */
export function calculateVAT(items: InvoiceItem[], includesVAT = false): number {
    return items.reduce((sum, item) => {
        const rate = item.vatRate || 0;
        let netPrice = item.unitPrice;
        if (includesVAT && rate) {
            netPrice = item.unitPrice / (1 + (rate / 100));
        }
        const netSubtotal = item.quantity * netPrice;
        return sum + (netSubtotal * rate / 100);
    }, 0);
}

/**
 * Calcula el total de la factura (subtotal + IVA)
 */
export function calculateTotal(items: InvoiceItem[], includesVAT = false): number {
    if (includesVAT) {
        return items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
    }
    const subtotal = calculateSubtotal(items, false);
    const vat = calculateVAT(items, false);
    return subtotal + vat;
}

/**
 * IVA agrupado por alícuota, redondeado de forma que los totales cierren al centavo.
 *
 * ARCA valida que la suma de `BaseImp` de los `AlicIva` sea igual a `ImpNeto`, y la
 * suma de `Importe` igual a `ImpIVA` (validaciones 10061 y 10051 del manual wsfev1).
 * Si el neto y el IVA del comprobante se redondean sobre el total y cada alícuota por
 * separado, con más de una alícuota (por ejemplo 21% y 10,5%) las sumas pueden diferir
 * en un centavo y ARCA rechaza el comprobante.
 *
 * Por eso cada alícuota se redondea una sola vez, en centavos, y `ImpNeto`/`ImpIVA`/
 * `ImpTotal` se derivan de este desglose (ver `sumVATBreakdown`). Con precios con IVA
 * incluido, el IVA de la alícuota es su total menos su base: así base + IVA es
 * exactamente lo cobrado.
 */
export function calculateVATBreakdown(
    items: InvoiceItem[],
    includesVAT = false
): { rate: number; taxBase: number; amount: number }[] {
    // Suma de cantidad × precio por alícuota (con IVA si includesVAT, neto si no).
    const byRate = new Map<number, number>();
    items.forEach(item => {
        const rate = item.vatRate || 0;
        byRate.set(rate, (byRate.get(rate) || 0) + item.quantity * item.unitPrice);
    });

    return Array.from(byRate.entries()).map(([rate, sum]) => {
        let baseCents: number;
        let amountCents: number;
        if (includesVAT) {
            const grossCents = Math.round(sum * 100);
            baseCents = Math.round((sum / (1 + rate / 100)) * 100);
            amountCents = grossCents - baseCents;
        } else {
            baseCents = Math.round(sum * 100);
            amountCents = Math.round(((sum * rate) / 100) * 100);
        }
        return { rate, taxBase: baseCents / 100, amount: amountCents / 100 };
    });
}

/**
 * Neto, IVA y total (sin otros tributos) que corresponden a un desglose por alícuota.
 * Se suman en centavos para que `net + vat === total` sin errores de punto flotante.
 */
export function sumVATBreakdown(
    breakdown: { taxBase: number; amount: number }[]
): { net: number; vat: number; total: number } {
    const netCents = breakdown.reduce((acc, e) => acc + Math.round(e.taxBase * 100), 0);
    const vatCents = breakdown.reduce((acc, e) => acc + Math.round(e.amount * 100), 0);
    return { net: netCents / 100, vat: vatCents / 100, total: (netCents + vatCents) / 100 };
}

/**
 * Redondea a 2 decimales
 */
export function round(value: number): number {
    return Math.round(value * 100) / 100;
}
