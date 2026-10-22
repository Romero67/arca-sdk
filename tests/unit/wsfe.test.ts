import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WsfeService } from '../../src/services/wsfe';
import { callArcaApi } from '../../src/utils/network';
import { InvoiceType, BillingConcept, TaxCondition, TaxIdType } from '../../src/types/wsfe';

vi.mock('../../src/utils/network', () => ({
    callArcaApi: vi.fn(),
}));

const MOCK_TICKET = {
    token: 'mock-token',
    sign: 'mock-sign',
    generationTime: new Date(),
    expirationTime: new Date(Date.now() + 3600000),
};

const BASE_CONFIG = {
    environment: 'homologacion' as const,
    cuit: '20123456789',
    ticket: MOCK_TICKET,
    pointOfSale: 4,
};

// Respuesta exitosa de FECompUltimoAutorizado (último nro = 0, próximo = 1)
const mockLastInvoiceXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FECompUltimoAutorizadoResult>
        <PtoVta>4</PtoVta>
        <CbteTipo>83</CbteTipo>
        <CbteNro>0</CbteNro>
      </FECompUltimoAutorizadoResult>
    </FECompUltimoAutorizadoResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

// Respuesta exitosa de FECAESolicitar
function buildMockCAEXml(type = 83): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FECAESolicitarResult>
        <FeCabResp>
          <Cuit>20123456789</Cuit>
          <PtoVta>4</PtoVta>
          <CbteTipo>${type}</CbteTipo>
          <FchProceso>20260220120000</FchProceso>
          <CantReg>1</CantReg>
          <Resultado>A</Resultado>
          <Reproceso>N</Reproceso>
        </FeCabResp>
        <FeDetResp>
          <FECAEDetResponse>
            <Concepto>1</Concepto>
            <DocTipo>99</DocTipo>
            <DocNro>0</DocNro>
            <CbteDesde>1</CbteDesde>
            <CbteHasta>1</CbteHasta>
            <CbteFch>20260220</CbteFch>
            <Resultado>A</Resultado>
            <CAE>75157992335329</CAE>
            <CAEFchVto>20260302</CAEFchVto>
          </FECAEDetResponse>
        </FeDetResp>
      </FECAESolicitarResult>
    </FECAESolicitarResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function mockCalls(caeType = 83): void {
    (callArcaApi as any)
        .mockResolvedValueOnce({ ok: true, text: async () => mockLastInvoiceXml })
        .mockResolvedValueOnce({ ok: true, text: async () => buildMockCAEXml(caeType) });
}

describe('WsfeService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Drop queued mockResolvedValueOnce answers a failing test did not consume.
        (callArcaApi as any).mockReset();
    });

    describe('constructor validation', () => {
        it('should throw if ticket is missing', () => {
            expect(() => new WsfeService({
                ...BASE_CONFIG,
                ticket: null as any,
            })).toThrow('Ticket WSAA requerido');
        });

        it('should throw if pointOfSale is invalid', () => {
            expect(() => new WsfeService({
                ...BASE_CONFIG,
                pointOfSale: 0,
            })).toThrow('Punto de venta inválido');
        });
    });

    describe('issueSimpleReceipt', () => {
        it('should issue a Ticket C with only a total amount', async () => {
            mockCalls(83);
            const wsfe = new WsfeService(BASE_CONFIG);
            const result = await wsfe.issueSimpleReceipt({ total: 1500 });

            expect(result.cae).toBe('75157992335329');
            expect(result.invoiceType).toBe(83);
            expect(result.invoiceNumber).toBe(1);
            expect(result.result).toBe('A');
            expect(result.qrUrl).toContain('afip.gob.ar/fe/qr');
            expect(callArcaApi).toHaveBeenCalledTimes(2);
        });
    });

    describe('issueReceipt', () => {
        it('should issue a Ticket C with items and return them in the response', async () => {
            mockCalls(83);
            const wsfe = new WsfeService(BASE_CONFIG);
            const items = [
                { description: 'Coca Cola', quantity: 2, unitPrice: 500 },
                { description: 'Pan lactal', quantity: 3, unitPrice: 250 },
            ];
            const result = await wsfe.issueReceipt({ items });

            expect(result.cae).toBeDefined();
            expect(result.items).toEqual(items);
            expect(result.items?.length).toBe(2);
        });
    });

    describe('issueInvoiceB', () => {
        it('should throw if items are missing vatRate', async () => {
            const wsfe = new WsfeService(BASE_CONFIG);
            await expect(wsfe.issueInvoiceB({
                items: [{ description: 'Servicio', quantity: 1, unitPrice: 1000 }], // no vatRate
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
            })).rejects.toThrow('vatRate');
        });

        it('should issue a Factura B with VAT breakdown', async () => {
            (callArcaApi as any)
                .mockResolvedValueOnce({ ok: true, text: async () => mockLastInvoiceXml })
                .mockResolvedValueOnce({ ok: true, text: async () => buildMockCAEXml(6) });

            const wsfe = new WsfeService(BASE_CONFIG);
            const result = await wsfe.issueInvoiceB({
                items: [{ description: 'Servicio', quantity: 1, unitPrice: 1000, vatRate: 21 }],
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
            });

            expect(result.cae).toBeDefined();
            expect(result.vat).toBeDefined();
            expect(result.vat?.[0].rate).toBe(21);
        });
    });

    describe('amounts sent to ARCA add up to the cent', () => {
        const cents = (v: string) => Math.round(Number(v) * 100);
        const tag = (xml: string, name: string) =>
            [...xml.matchAll(new RegExp(`<ar:${name}>([^<]*)</ar:${name}>`, 'g'))].map((m) => m[1]);

        /** Issues a Factura B and returns the amounts of the FECAESolicitar body. */
        async function sentAmounts(
            items: { quantity: number; unitPrice: number; vatRate: number }[],
            includesVAT: boolean,
        ) {
            mockCalls(6);
            const wsfe = new WsfeService(BASE_CONFIG);
            await wsfe.issueInvoiceB({
                items: items.map((i) => ({ description: 'x', ...i })),
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
                includesVAT,
            });
            const body: string = (callArcaApi as any).mock.calls.at(-1)[1].body;
            return {
                total: cents(tag(body, 'ImpTotal')[0]),
                net: cents(tag(body, 'ImpNeto')[0]),
                vat: cents(tag(body, 'ImpIVA')[0]),
                bases: tag(body, 'BaseImp').map(cents),
                vatAmounts: tag(body, 'Importe').map(cents),
            };
        }

        function expectConsistent(a: Awaited<ReturnType<typeof sentAmounts>>) {
            expect(a.bases.reduce((s, b) => s + b, 0)).toBe(a.net);
            expect(a.vatAmounts.reduce((s, b) => s + b, 0)).toBe(a.vat);
            expect(a.net + a.vat).toBe(a.total);
        }

        it('mixed 21% + 10.5% with VAT included: AlicIva sums match ImpNeto/ImpIVA and ImpTotal is what was charged', async () => {
            const a = await sentAmounts(
                [
                    { quantity: 1, unitPrice: 1000, vatRate: 21 },
                    { quantity: 1, unitPrice: 1000, vatRate: 10.5 },
                ],
                true,
            );
            expectConsistent(a);
            expect(a.total).toBe(200000);
        });

        it('mixed rates with VAT included stay consistent across many carts', async () => {
            for (let p21 = 101; p21 < 1500; p21 += 97) {
                for (let p105 = 103; p105 < 1500; p105 += 89) {
                    const a = await sentAmounts(
                        [
                            { quantity: 3, unitPrice: p21 + 0.37, vatRate: 21 },
                            { quantity: 2, unitPrice: p105 + 0.59, vatRate: 10.5 },
                        ],
                        true,
                    );
                    expectConsistent(a);
                    expect(a.total).toBe(Math.round((3 * (p21 + 0.37) + 2 * (p105 + 0.59)) * 100));
                }
            }
        });

        it('mixed rates with net prices: AlicIva sums match and ImpTotal = ImpNeto + ImpIVA', async () => {
            const a = await sentAmounts(
                [
                    { quantity: 3, unitPrice: 826.45, vatRate: 21 },
                    { quantity: 7, unitPrice: 904.98, vatRate: 10.5 },
                ],
                false,
            );
            expectConsistent(a);
        });

        it('single 21% rate with VAT included keeps its previous amounts (1210 = 1000 + 210)', async () => {
            const a = await sentAmounts([{ quantity: 1, unitPrice: 1210, vatRate: 21 }], true);
            expect(a).toEqual({ total: 121000, net: 100000, vat: 21000, bases: [100000], vatAmounts: [21000] });
        });

        it('single 21% rate with net prices keeps its previous amounts (1000 + 210 = 1210)', async () => {
            const a = await sentAmounts([{ quantity: 1, unitPrice: 1000, vatRate: 21 }], false);
            expect(a).toEqual({ total: 121000, net: 100000, vat: 21000, bases: [100000], vatAmounts: [21000] });
        });
    });

    describe('FECAESolicitar request follows the wsfev1 schema', () => {
        // xs:sequence of FECAEDetRequest in the wsfev1 WSDL (only the elements this SDK sends).
        const XSD_ORDER = [
            'Concepto', 'DocTipo', 'DocNro', 'CbteDesde', 'CbteHasta', 'CbteFch',
            'ImpTotal', 'ImpTotConc', 'ImpNeto', 'ImpOpEx', 'ImpTrib', 'ImpIVA',
            'MonId', 'MonCotiz', 'CondicionIVAReceptorId', 'CbtesAsoc', 'Iva',
        ];

        function detElements(body: string): string[] {
            const det = body.split('<ar:FECAEDetRequest>')[1].split('</ar:FECAEDetRequest>')[0];
            const names: string[] = [];
            let depth = 0;
            for (const m of det.matchAll(/<(\/?)ar:(\w+)>/g)) {
                if (m[1]) {
                    depth--;
                } else {
                    if (depth === 0) names.push(m[2]);
                    depth++;
                }
            }
            return names;
        }

        it('Factura B: elements are in XSD order', async () => {
            mockCalls(6);
            const wsfe = new WsfeService(BASE_CONFIG);
            await wsfe.issueInvoiceB({
                items: [{ description: 'x', quantity: 1, unitPrice: 1210, vatRate: 21 }],
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
                includesVAT: true,
            });
            const body: string = (callArcaApi as any).mock.calls.at(-1)[1].body;
            const sent = detElements(body);
            expect(sent).toEqual(XSD_ORDER.filter((n) => sent.includes(n)));
            expect(sent).toContain('CondicionIVAReceptorId');
            expect(sent).toContain('Iva');
        });

        it('Nota de Crédito B: elements are in XSD order, CbtesAsoc before Iva', async () => {
            mockCalls(8);
            const wsfe = new WsfeService(BASE_CONFIG);
            await wsfe.issueNotaCreditoB({
                items: [{ description: 'x', quantity: 1, unitPrice: 1210, vatRate: 21 }],
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
                includesVAT: true,
                cbteAsociados: [{ tipo: 6, puntoVenta: 4, numero: 10 }],
            });
            const body: string = (callArcaApi as any).mock.calls.at(-1)[1].body;
            const sent = detElements(body);
            expect(sent).toEqual(XSD_ORDER.filter((n) => sent.includes(n)));
            expect(sent).toContain('CbtesAsoc');
        });
    });

    describe('VAT rates', () => {
        async function sentAlicIvaIds(vatRate: number): Promise<string[]> {
            mockCalls(6);
            const wsfe = new WsfeService(BASE_CONFIG);
            await wsfe.issueInvoiceB({
                items: [{ description: 'x', quantity: 1, unitPrice: 1000, vatRate }],
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
            });
            const body: string = (callArcaApi as any).mock.calls.at(-1)[1].body;
            const iva = body.split('<ar:Iva>')[1];
            return [...iva.matchAll(/<ar:Id>(\d+)<\/ar:Id>/g)].map((m) => m[1]);
        }

        it.each([
            [0, '3'], [10.5, '4'], [21, '5'], [27, '6'], [5, '8'], [2.5, '9'],
        ])('%s%% is sent as AlicIva Id %s', async (rate, id) => {
            expect(await sentAlicIvaIds(rate)).toEqual([id]);
        });

        it('rejects a rate ARCA does not have', async () => {
            mockCalls(6);
            const wsfe = new WsfeService(BASE_CONFIG);
            await expect(wsfe.issueInvoiceB({
                items: [{ description: 'x', quantity: 1, unitPrice: 1000, vatRate: 15 }],
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
            })).rejects.toThrow('Alícuota IVA inválida: 15%');
        });
    });

    describe('TaxCondition catalogue (CondicionIVAReceptorId)', () => {
        it('matches the ARCA codes', () => {
            expect(TaxCondition.REGISTERED_TAXPAYER).toBe(1);
            expect(TaxCondition.EXEMPT).toBe(4);
            expect(TaxCondition.FINAL_CONSUMER).toBe(5);
            expect(TaxCondition.MONOTAX_PAYER).toBe(6);
            expect(TaxCondition.UNCATEGORIZED).toBe(7);
            expect(TaxCondition.FOREIGN_SUPPLIER).toBe(8);
            expect(TaxCondition.FOREIGN_CLIENT).toBe(9);
            expect(TaxCondition.VAT_EXEMPT_LAW_19640).toBe(10);
            expect(TaxCondition.SOCIAL_MONOTAX).toBe(13);
            expect(TaxCondition.VAT_NOT_REACHED).toBe(15);
            expect(TaxCondition.PROMOTED_INDEPENDENT_MONOTAX).toBe(16);
        });

        it('the deprecated VAT_NOT_APPLICABLE ("No Alcanzado") now sends 15, not 10', async () => {
            expect(TaxCondition.VAT_NOT_APPLICABLE).toBe(15);
            mockCalls(6);
            const wsfe = new WsfeService(BASE_CONFIG);
            await wsfe.issueInvoiceB({
                items: [{ description: 'x', quantity: 1, unitPrice: 1000, vatRate: 21 }],
                buyer: { docType: TaxIdType.CUIT, docNumber: '20987654321' },
                taxConditionBuyer: TaxCondition.VAT_NOT_APPLICABLE,
            });
            const body: string = (callArcaApi as any).mock.calls.at(-1)[1].body;
            expect(body).toContain('<ar:CondicionIVAReceptorId>15</ar:CondicionIVAReceptorId>');
        });
    });

    describe('buyer on Factura C and Nota de Crédito C', () => {
        const items = [{ description: 'x', quantity: 1, unitPrice: 1000 }];
        const cbteAsociados = [{ tipo: 11, puntoVenta: 1, numero: 10 }];
        const sent = () => {
            const body: string = (callArcaApi as any).mock.calls.at(-1)[1].body;
            const tag = (t: string) => body.match(new RegExp(`<ar:${t}>([^<]*)</ar:${t}>`))?.[1];
            return { docType: tag('DocTipo'), docNumber: tag('DocNro'), condition: tag('CondicionIVAReceptorId') };
        };

        it('Factura C sends the buyer it receives', async () => {
            mockCalls(11);
            await new WsfeService(BASE_CONFIG).issueInvoiceC({
                items,
                buyer: { docType: TaxIdType.CUIT, docNumber: '30711222333' },
                taxConditionBuyer: TaxCondition.REGISTERED_TAXPAYER,
            });
            expect(sent()).toEqual({ docType: '80', docNumber: '30711222333', condition: '1' });
        });

        it('Factura C without a buyer still sends 99/0', async () => {
            mockCalls(11);
            await new WsfeService(BASE_CONFIG).issueInvoiceC({ items, taxConditionBuyer: TaxCondition.FINAL_CONSUMER });
            expect(sent()).toEqual({ docType: '99', docNumber: '0', condition: '5' });
        });

        it('Nota de Crédito C sends the buyer it receives', async () => {
            mockCalls(13);
            await new WsfeService(BASE_CONFIG).issueNotaCreditoC({
                items,
                cbteAsociados,
                buyer: { docType: TaxIdType.CUIT, docNumber: '20123456786' },
                taxConditionBuyer: TaxCondition.MONOTAX_PAYER,
            });
            expect(sent()).toEqual({ docType: '80', docNumber: '20123456786', condition: '6' });
        });

        it('Nota de Crédito C without a buyer still sends 99/0', async () => {
            mockCalls(13);
            await new WsfeService(BASE_CONFIG).issueNotaCreditoC({ items, cbteAsociados, taxConditionBuyer: TaxCondition.FINAL_CONSUMER });
            expect(sent()).toEqual({ docType: '99', docNumber: '0', condition: '5' });
        });
    });

    describe('receiver VAT condition on Factura A and Nota de Crédito A', () => {
        const items = [{ description: 'x', quantity: 1, unitPrice: 1000, vatRate: 21 }];
        const buyer = { docType: TaxIdType.CUIT, docNumber: '20987654321' };
        const cbteAsociados = [{ tipo: 1, puntoVenta: 1, numero: 10 }];
        const sentCondition = () =>
            (callArcaApi as any).mock.calls.at(-1)[1].body.match(
                /<ar:CondicionIVAReceptorId>(\d+)<\/ar:CondicionIVAReceptorId>/,
            )?.[1];

        it('Factura A to a monotributista sends condition 6', async () => {
            mockCalls(1);
            await new WsfeService(BASE_CONFIG).issueInvoiceA({
                items, buyer, taxConditionBuyer: TaxCondition.MONOTAX_PAYER,
            });
            expect(sentCondition()).toBe('6');
        });

        it('Factura A without a condition still sends 1 (Responsable Inscripto)', async () => {
            mockCalls(1);
            await new WsfeService(BASE_CONFIG).issueInvoiceA({ items, buyer });
            expect(sentCondition()).toBe('1');
        });

        it('Nota de Crédito A to a monotributista sends condition 6', async () => {
            mockCalls(3);
            await new WsfeService(BASE_CONFIG).issueNotaCreditoA({
                items, buyer, cbteAsociados, taxConditionBuyer: TaxCondition.MONOTAX_PAYER,
            });
            expect(sentCondition()).toBe('6');
        });

        it('Nota de Crédito A without a condition still sends 1 (Responsable Inscripto)', async () => {
            mockCalls(3);
            await new WsfeService(BASE_CONFIG).issueNotaCreditoA({ items, buyer, cbteAsociados });
            expect(sentCondition()).toBe('1');
        });
    });

    describe('checkStatus (static)', () => {
        it('should return server status', async () => {
            const mockStatusXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <FEDummyResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FEDummyResult>
        <AppServer>OK</AppServer>
        <DbServer>OK</DbServer>
        <AuthServer>OK</AuthServer>
      </FEDummyResult>
    </FEDummyResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

            (callArcaApi as any).mockResolvedValueOnce({
                ok: true,
                text: async () => mockStatusXml,
            });

            const status = await WsfeService.checkStatus('homologacion');
            expect(status.appServer).toBe('OK');
            expect(status.dbServer).toBe('OK');
            expect(status.authServer).toBe('OK');
        });
    });
});
