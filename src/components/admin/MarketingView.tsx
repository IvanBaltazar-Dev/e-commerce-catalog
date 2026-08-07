"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, type OperableBranch } from "@/lib/admin/api";
import {
  CHANNEL_LABELS,
  type CampaignInfo,
  type ChannelInfo,
  type OmnichannelMetrics
} from "@/lib/admin/omnichannel";
import { formatSoles } from "@/lib/public/catalog";

type Tab = "atribucion" | "campanas" | "canales" | "tendencias";

const TAB_LABELS: Record<Tab, string> = {
  atribucion: "Atribución",
  campanas: "Campañas",
  canales: "Canales",
  tendencias: "Tendencias"
};

const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  approved: "Aprobada",
  rejected: "Rechazada",
  published: "Publicada"
};

/**
 * Marketing operativo en una pantalla con tres pestañas: qué produjo cada
 * origen (atribución), qué campañas existen y qué cuentas de canal hay.
 * No es un dashboard gigantesco: son los datos confiables del plan.
 */
export function MarketingView({ initialTab = "atribucion" }: { initialTab?: Tab }) {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [tab, setTab] = useState<Tab>(initialTab);

  const [metrics, setMetrics] = useState<OmnichannelMetrics | null>(null);
  const [chains, setChains] = useState<Awaited<ReturnType<typeof adminApi.getAttribution>>["chains"]>([]);
  const [campaigns, setCampaigns] = useState<CampaignInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [branches, setBranches] = useState<OperableBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [campaignName, setCampaignName] = useState("");
  const [campaignCode, setCampaignCode] = useState("");
  const [campaignSource, setCampaignSource] = useState("instagram");

  const [proposals, setProposals] = useState<Awaited<ReturnType<typeof adminApi.listTrendProposals>>>([]);
  const [generating, setGenerating] = useState(false);

  const [accountChannel, setAccountChannel] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountExternal, setAccountExternal] = useState("");
  const [accountBranch, setAccountBranch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [attribution, campaignItems, channelItems, branchItems, proposalItems] = await Promise.all([
        adminApi.getAttribution(),
        adminApi.listCampaigns(),
        adminApi.listChannels(),
        adminApi.listOperableBranches(),
        adminApi.listTrendProposals()
      ]);
      setMetrics(attribution.metrics);
      setChains(attribution.chains);
      setCampaigns(campaignItems);
      setChannels(channelItems);
      setBranches(branchItems);
      setProposals(proposalItems);
    } catch (error) {
      handleApiError(error, "No se pudo cargar marketing.");
    } finally {
      setLoading(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    load();
  }, [load]);

  async function createCampaign() {
    if (saving) return;
    setSaving(true);
    try {
      await adminApi.createCampaign({
        name: campaignName.trim(),
        code: campaignCode.trim().toLowerCase(),
        sourceCode: campaignSource || null,
        channelCode: campaignSource in CHANNEL_LABELS ? campaignSource : null,
        startsAt: null,
        endsAt: null
      });
      showToast("Campaña creada ✓");
      setCampaignName("");
      setCampaignCode("");
      await load();
    } catch (error) {
      handleApiError(error, "No se pudo crear la campaña.");
    } finally {
      setSaving(false);
    }
  }

  async function generateProposal() {
    if (generating) return;
    setGenerating(true);
    try {
      const result = await adminApi.generateTrendProposal();
      showToast(`Borrador creado: «${result.titulo}»`);
      setProposals(await adminApi.listTrendProposals());
    } catch (error) {
      handleApiError(error, "No se pudo generar la propuesta.");
    } finally {
      setGenerating(false);
    }
  }

  async function actOnProposal(proposalId: string, accion: "approved" | "rejected" | "published") {
    if (saving) return;
    setSaving(true);
    try {
      const nota =
        accion === "published"
          ? window.prompt("¿Dónde la publicaste? (opcional)", "Instagram") ?? undefined
          : undefined;
      await adminApi.actOnTrendProposal({ proposalId, accion, nota: nota ?? null });
      showToast(
        accion === "approved" ? "Propuesta aprobada ✓"
          : accion === "rejected" ? "Propuesta rechazada"
            : "Registrado: la publicaste tú ✓"
      );
      setProposals(await adminApi.listTrendProposals());
    } catch (error) {
      handleApiError(error, "No se pudo actualizar la propuesta.");
    } finally {
      setSaving(false);
    }
  }

  async function createAccount() {
    if (saving || !accountChannel) return;
    setSaving(true);
    try {
      await adminApi.createChannelAccount({
        channelId: accountChannel,
        displayName: accountName.trim(),
        externalAccountId: accountExternal.trim(),
        branchId: accountBranch || null
      });
      showToast("Cuenta registrada ✓");
      setAccountName("");
      setAccountExternal("");
      await load();
    } catch (error) {
      handleApiError(error, "No se pudo registrar la cuenta.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">Marketing y canales</div>
          <div className="field-hint">Todo importe nace de ventas reales del Bloque 2.</div>
        </div>
        <div className="order-delivery" style={{ margin: 0, minWidth: 440, gridTemplateColumns: "repeat(4, 1fr)" }}>
          {(["atribucion", "campanas", "canales", "tendencias"] as Tab[]).map((option) => (
            <button key={option} type="button"
              className={tab === option ? "order-delivery-option order-delivery-option--active" : "order-delivery-option"}
              onClick={() => setTab(option)}>
              {TAB_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="order-loading"><span className="spinner spinner--pink" /> Cargando…</div>
      ) : null}

      {!loading && tab === "atribucion" && metrics ? (
        <>
          <section className="form-card">
            <div className="order-section-title">Ventas por canal (últimos 30 días)</div>
            <div className="metric-grid">
              {Object.entries(metrics.salesByChannel).length === 0 ? (
                <div className="order-empty">Aún no hay ventas en la ventana.</div>
              ) : Object.entries(metrics.salesByChannel).map(([channel, data]) => (
                <div key={channel} className="metric-tile">
                  <small>{CHANNEL_LABELS[channel] ?? channel}</small>
                  <b>{formatSoles(data.revenue)}</b>
                  <span>{data.count} venta(s) · ticket {formatSoles(data.averageTicket)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="form-card">
            <div className="order-section-title">Embudo</div>
            <div className="metric-grid">
              <div className="metric-tile"><small>Carritos creados</small><b>{metrics.carts.created}</b></div>
              <div className="metric-tile"><small>Abandonados</small><b>{metrics.carts.abandoned}</b></div>
              <div className="metric-tile"><small>Convertidos</small><b>{metrics.carts.converted}</b></div>
              <div className="metric-tile">
                <small>Conversión carrito → venta</small>
                <b>{metrics.cartToSaleConversion == null ? "—" : `${(metrics.cartToSaleConversion * 100).toFixed(1)}%`}</b>
              </div>
              <div className="metric-tile">
                <small>Conversación → venta</small>
                <b>{metrics.conversationToSaleConversion == null ? "—" : `${(metrics.conversationToSaleConversion * 100).toFixed(1)}%`}</b>
              </div>
              <div className="metric-tile">
                <small>Primera atención</small>
                <b>{metrics.avgMinutesToFirstReply == null ? "—" : `${metrics.avgMinutesToFirstReply} min`}</b>
              </div>
              <div className="metric-tile">
                <small>Del primer toque a la venta</small>
                <b>{metrics.avgHoursToSale == null ? "—" : `${metrics.avgHoursToSale} h`}</b>
              </div>
            </div>
          </section>

          <section className="form-card order-history">
            <div className="order-section-title">Cadenas recientes</div>
            {chains.length === 0 ? (
              <div className="order-empty">Aún no hay recorridos registrados.</div>
            ) : (
              <div className="order-history-list">
                {chains.map((chain) => (
                  <div key={chain.id} className="sale-reservation">
                    <span>
                      <b>{chain.firstSource ?? "?"} → {chain.lastSource ?? "?"}</b>
                      <small>{chain.campaign ?? "sin campaña"}</small>
                    </span>
                    <span><small>Primer toque</small>{new Date(chain.firstTouchAt).toLocaleDateString("es-PE")}</span>
                    <span className="conv-badges">
                      {chain.hasConversation ? <span className="conv-badge">conversación</span> : null}
                      {chain.hasCart ? <span className="conv-badge">carrito</span> : null}
                      {chain.hasSale ? <span className="conv-badge conv-badge--sale">venta</span> : null}
                    </span>
                    <span />
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}

      {!loading && tab === "campanas" ? (
        <>
          <section className="form-card">
            <div className="order-section-title">Nueva campaña</div>
            <div className="order-customer-fields">
              <label><span>Nombre</span>
                <input className="input" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="Vitrina de agosto" />
              </label>
              <label><span>Código (va en la URL y el QR)</span>
                <input className="input" value={campaignCode} onChange={(event) => setCampaignCode(event.target.value)} placeholder="vitrina-agosto" />
              </label>
              <label><span>Fuente</span>
                <select className="input" value={campaignSource} onChange={(event) => setCampaignSource(event.target.value)}>
                  {["instagram", "facebook", "tiktok", "whatsapp", "qr", "paid", "referral", "organic"].map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="order-actions">
              <button type="button" className="btn-save" disabled={saving || !campaignName.trim() || !campaignCode.trim()} onClick={createCampaign}>
                Crear campaña
              </button>
            </div>
            <div className="field-hint">
              Enlace listo: <code>bellaroshe.pe/?source={campaignSource || "qr"}&campaign={campaignCode || "codigo"}</code>
            </div>
          </section>

          <section className="form-card order-history">
            {campaigns.length === 0 ? (
              <div className="order-empty">Aún no hay campañas.</div>
            ) : (
              <div className="order-history-list">
                {campaigns.map((campaign) => (
                  <div key={campaign.id} className="sale-reservation">
                    <span><b>{campaign.name}</b><small>{campaign.code}</small></span>
                    <span><small>Fuente</small>{campaign.sourceCode ?? "—"}</span>
                    <span><small>Canal</small>{campaign.channelCode ?? "—"}</span>
                    <span className={`order-status order-status--${campaign.isActive ? "confirmed" : "cancelled"}`}>
                      {campaign.isActive ? "Activa" : "Inactiva"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}

      {!loading && tab === "canales" ? (
        <>
          <section className="form-card">
            <div className="order-section-title">Nueva cuenta de canal</div>
            <div className="order-customer-fields">
              <label><span>Canal</span>
                <select className="input" value={accountChannel} onChange={(event) => setAccountChannel(event.target.value)}>
                  <option value="">Elegir…</option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>{channel.name}</option>
                  ))}
                </select>
              </label>
              <label><span>Nombre visible</span>
                <input className="input" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="WhatsApp principal" />
              </label>
              <label><span>Identidad externa</span>
                <input className="input" value={accountExternal} onChange={(event) => setAccountExternal(event.target.value)} placeholder="phone_number_id / page_id" />
              </label>
              <label><span>Sede (opcional)</span>
                <select className="input" value={accountBranch} onChange={(event) => setAccountBranch(event.target.value)}>
                  <option value="">Global</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>
            </div>
            <div className="order-actions">
              <button type="button" className="btn-save"
                disabled={saving || !accountChannel || !accountName.trim() || !accountExternal.trim()}
                onClick={createAccount}>
                Registrar cuenta
              </button>
            </div>
            <div className="field-hint">
              Los tokens y secretos van en el entorno del servidor, nunca aquí.
            </div>
          </section>

          <section className="form-card order-history">
            <div className="order-history-list">
              {channels.map((channel) => (
                <div key={channel.id} className="sale-reservation">
                  <span>
                    <b>{channel.name}</b>
                    <small>
                      {channel.supportsMessages ? "mensajes" : "sin mensajes"} ·{" "}
                      {channel.supportsCart ? "carrito" : "sin carrito"}
                    </small>
                  </span>
                  <span style={{ gridColumn: "2 / 4" }}>
                    {channel.accounts.length === 0
                      ? <small>Sin cuentas registradas</small>
                      : channel.accounts.map((account) => (
                          <small key={account.id} style={{ display: "block" }}>
                            {account.displayName} · {account.externalAccountId ?? "—"}
                          </small>
                        ))}
                  </span>
                  <span className={`order-status order-status--${channel.isActive ? "confirmed" : "cancelled"}`}>
                    {channel.isActive ? "Activo" : "Inactivo"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {!loading && tab === "tendencias" ? (
        <>
          <section className="form-card">
            <div className="order-section-title">Propuestas de contenido</div>
            <div className="field-hint">
              El sistema propone desde tus ventas reales; aprobar, rechazar y publicar es SIEMPRE decisión tuya.
              Nada se publica solo.
            </div>
            <div className="order-actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn-save" disabled={generating} onClick={generateProposal}>
                {generating ? "Leyendo señales…" : "Generar propuesta desde mis ventas"}
              </button>
            </div>
          </section>

          <section className="form-card order-history">
            {proposals.length === 0 ? (
              <div className="order-empty">Aún no hay propuestas. Genera la primera desde tus señales.</div>
            ) : (
              <div className="trend-list">
                {proposals.map((proposal) => (
                  <div key={proposal.id} className="trend-card">
                    <div className="trend-head">
                      <b>{proposal.titulo}</b>
                      <span className={`order-status order-status--${proposal.estado === "rejected" ? "cancelled" : "confirmed"}`}>
                        {PROPOSAL_STATUS_LABELS[proposal.estado] ?? proposal.estado}
                      </span>
                    </div>
                    <p className="trend-body">{proposal.cuerpo}</p>
                    <div className="trend-actions">
                      {proposal.estado === "draft" ? (
                        <>
                          <button type="button" className="btn-save" disabled={saving}
                            onClick={() => actOnProposal(proposal.id, "approved")}>
                            Aprobar
                          </button>
                          <button type="button" className="btn-cancel" disabled={saving}
                            onClick={() => actOnProposal(proposal.id, "rejected")}>
                            Rechazar
                          </button>
                        </>
                      ) : null}
                      {proposal.estado === "approved" ? (
                        <>
                          <button type="button" className="btn-soft"
                            onClick={() => {
                              void navigator.clipboard.writeText(`${proposal.titulo}\n\n${proposal.cuerpo}`);
                              showToast("Contenido copiado ✓");
                            }}>
                            Copiar contenido
                          </button>
                          <button type="button" className="btn-save" disabled={saving}
                            onClick={() => actOnProposal(proposal.id, "published")}>
                            Ya la publiqué yo
                          </button>
                        </>
                      ) : null}
                      {proposal.notaRevision ? <small className="field-hint">Nota: {proposal.notaRevision}</small> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
