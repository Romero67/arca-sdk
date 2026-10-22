import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PadronService } from '../../src/services/padron';
import { callArcaApi } from '../../src/utils/network';
import { WsaaService } from '../../src/auth/wsaa';

vi.mock('../../src/utils/network', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/network')>()),
  callArcaApi: vi.fn(),
}));

describe('PadronService (A13)', () => {
  const config = {
    environment: 'homologacion' as const,
    cuit: '20123456789',
    cert: '-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----',
    key: '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----',
  };

  const service = new PadronService(config);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(WsaaService.prototype, 'login').mockResolvedValue({
      token: 'mock-token',
      sign: 'mock-sign',
      generationTime: new Date(),
      expirationTime: new Date(Date.now() + 3600000),
    } as any);
  });

  it('should parse a successful getTaxpayer response correctly', async () => {
    const mockPadronXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getPersonaResponse xmlns="http://a13.soap.ws.server.puc.sr/">
      <personaReturn>
        <persona>
          <idPersona>20123456789</idPersona>
          <tipoPersona>FISICA</tipoPersona>
          <nombre>JUAN</nombre>
          <apellido>PEREZ</apellido>
          <estadoClave>ACTIVO</estadoClave>
          <domicilio>
            <direccion>CALLE FALSA 123</direccion>
            <localidad>CABA</localidad>
            <codPostal>1000</codPostal>
            <idProvincia>0</idProvincia>
            <descripcionProvincia>CIUDAD AUTONOMA BUENOS AIRES</descripcionProvincia>
            <tipoDomicilio>FISCAL</tipoDomicilio>
          </domicilio>
          <impuesto>
            <idImpuesto>30</idImpuesto>
            <descripcionImpuesto>IVA</descripcionImpuesto>
          </impuesto>
          <impuesto>
            <idImpuesto>10</idImpuesto>
            <descripcionImpuesto>GANANCIAS SOCIEDADES</descripcionImpuesto>
          </impuesto>
          <descripcionActividadPrincipal>VENTA AL POR MENOR</descripcionActividadPrincipal>
        </persona>
      </personaReturn>
    </getPersonaResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

    (callArcaApi as any).mockResolvedValue({
      ok: true,
      text: async () => mockPadronXml,
    });

    const result = await service.getTaxpayer('20123456789');

    expect(result.taxpayer).toBeDefined();
    expect(result.taxpayer?.firstName).toBe('JUAN');
    expect(result.taxpayer?.lastName).toBe('PEREZ');
    expect(result.taxpayer?.isVATRegistered).toBe(true);
    expect(result.taxpayer?.isMonotax).toBe(false);
    expect(result.taxpayer?.addresses[0].street).toBe('CALLE FALSA 123');
    expect(result.taxpayer?.addresses[0].province).toBe('CIUDAD AUTONOMA BUENOS AIRES');
  });

  it('should handle "CUIT not found" response', async () => {
    const mockPadronXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getPersonaResponse xmlns="http://a13.soap.ws.server.puc.sr/">
      <personaReturn>
        <metadata>
            <fechaHora>2026-02-21T10:00:00</fechaHora>
        </metadata>
      </personaReturn>
    </getPersonaResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

    (callArcaApi as any).mockResolvedValue({
      ok: true,
      text: async () => mockPadronXml,
    });

    const result = await service.getTaxpayer('22222222222');
    expect(result.error).toBe('CUIT no encontrado');
  });
  // A13 sends its business faults with HTTP 500 (verified upstream against homologación).
  it('returns the SOAP fault as an error when ARCA answers HTTP 500', async () => {
    const faultXml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>La Clave (CUIT/CUIL) consultada es inexistente</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;

    (callArcaApi as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => faultXml,
    });

    const result = await service.getTaxpayer('20000000001');
    expect(result).toEqual({ error: 'La Clave (CUIT/CUIL) consultada es inexistente' });
  });

  it('still throws an HTTP error when a non-2xx answer carries no SOAP fault', async () => {
    (callArcaApi as any).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => '',
    });

    await expect(service.getTaxpayer('20000000001')).rejects.toThrow('503 Service Unavailable');
  });
});
