import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import LoginScreen from "./components/LoginScreen";
import "./App.css";

const ACCESS_KEY = "control-prestamos-access";
const DEFAULT_PASSWORD = "1234";
const CLIENTS_KEY = "control-prestamos-clients";
const LOANS_KEY = "control-prestamos-loans";

const frecuencias = {
  semanal: { cuotasPorMes: 4, dias: 7, label: "Semanal" },
  quincenal: { cuotasPorMes: 2, dias: 15, label: "Quincenal" },
  mensual: { cuotasPorMes: 1, dias: 30, label: "Mensual" },
  solo_intereses: { cuotasPorMes: 1, dias: 30, label: "Solo intereses" },
};

function money(value) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(dateString + "T00:00:00");
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(dateString) {
  if (!dateString) return "-";
  return new Date(dateString + "T00:00:00").toLocaleDateString("es-CO");
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function onlyDigits(text) {
  return String(text || "").replace(/\D/g, "");
}

function clientIdFromCount(count) {
  return `CLI-${String(count + 1).padStart(4, "0")}`;
}

function loanIdFromCount(count) {
  return `PRE-${String(count + 1).padStart(4, "0")}`;
}

function getSavedAccess() {
  try {
    const raw = localStorage.getItem(ACCESS_KEY);
    if (!raw) return { password: DEFAULT_PASSWORD };
    return JSON.parse(raw);
  } catch {
    return { password: DEFAULT_PASSWORD };
  }
}

function saveAccess(data) {
  localStorage.setItem(ACCESS_KEY, JSON.stringify(data));
}

function getClientByDocument(clients, documento) {
  const clean = String(documento || "").trim();
  return clients.find((client) => String(client.documento).trim() === clean) || null;
}

function buildLoan(data, existingLoans, client) {
  const capital = Number(data.capital || 0);
  const interesPct = Number(data.interesPct || 0);
  const plazoMeses = Number(data.plazoMeses || 0);
  const config = frecuencias[data.frecuencia] || frecuencias.mensual;

  if (!capital || !interesPct || !data.fechaInicio || !client?.documento || !client?.nombre) {
    return null;
  }

  const internalId = Date.now().toString();
  const prestamoId = loanIdFromCount(existingLoans.length);

  if (data.frecuencia === "solo_intereses") {
    const interesMensual = capital * (interesPct / 100);

    const cuotas = [
      {
        id: `${internalId}-1`,
        numero: 1,
        fechaVencimiento: data.fechaInicio,
        valorProgramado: round2(interesMensual),
        capitalProgramado: 0,
        interesProgramado: round2(interesMensual),
        valorPagado: 0,
        fechaPago: "",
        recordatorioEnviado: false,
        estado: "Pendiente",
      },
    ];

    return recalculateLoan({
      id: internalId,
      prestamoId,
      clienteId: client.clienteId,
      documentoCliente: client.documento,
      cliente: client.nombre,
      documento: client.documento,
      telefono: client.telefono,
      direccion: client.direccion,
      capital,
      capitalPendiente: capital,
      interesPct,
      plazoMeses: 0,
      frecuencia: "solo_intereses",
      fechaInicio: data.fechaInicio,
      interesTotal: round2(interesMensual),
      totalPagar: round2(capital + interesMensual),
      valorCuota: round2(interesMensual),
      cuotas,
      paymentHistory: [],
      estado: "Activo",
      createdAt: new Date().toISOString(),
    });
  }

  const numeroCuotas = plazoMeses * config.cuotasPorMes;

  if (!plazoMeses || !numeroCuotas) {
    return null;
  }

  const interesTotal = capital * (interesPct / 100) * plazoMeses;
  const totalPagar = capital + interesTotal;
  const valorCuota = totalPagar / numeroCuotas;
  const capitalPorCuota = capital / numeroCuotas;
  const interesPorCuota = interesTotal / numeroCuotas;

  const cuotas = Array.from({ length: numeroCuotas }, (_, index) => ({
    id: `${internalId}-${index + 1}`,
    numero: index + 1,
    fechaVencimiento: addDays(data.fechaInicio, config.dias * index),
    valorProgramado: round2(valorCuota),
    capitalProgramado: round2(capitalPorCuota),
    interesProgramado: round2(interesPorCuota),
    valorPagado: 0,
    fechaPago: "",
    recordatorioEnviado: false,
    estado: "Pendiente",
  }));

  return recalculateLoan({
    id: internalId,
    prestamoId,
    clienteId: client.clienteId,
    documentoCliente: client.documento,
    cliente: client.nombre,
    documento: client.documento,
    telefono: client.telefono,
    direccion: client.direccion,
    capital,
    capitalPendiente: capital,
    interesPct,
    plazoMeses,
    frecuencia: data.frecuencia,
    fechaInicio: data.fechaInicio,
    interesTotal: round2(interesTotal),
    totalPagar: round2(totalPagar),
    valorCuota: round2(valorCuota),
    cuotas,
    paymentHistory: [],
    estado: "Activo",
    createdAt: new Date().toISOString(),
  });
}

function recalculateLoan(loan) {
  const today = todayISO();
  const isSoloIntereses = loan.frecuencia === "solo_intereses";

  let cuotas = (loan.cuotas || []).map((cuota) => {
    const valorPagado = Number(cuota.valorPagado || 0);
    const valorProgramado = Number(cuota.valorProgramado || 0);
    let estado = "Pendiente";

    if (valorPagado >= valorProgramado) estado = "Pagada";
    else if (valorPagado > 0) estado = "Abono";
    else if (cuota.fechaVencimiento < today) estado = "Vencida";

    return { ...cuota, estado };
  });

  if (isSoloIntereses && cuotas.length) {
    const ultimaCuota = cuotas[cuotas.length - 1];
    const interesMensual = round2(
      Number(loan.capitalPendiente ?? loan.capital ?? 0) * (Number(loan.interesPct || 0) / 100)
    );

    if (ultimaCuota.estado === "Pagada") {
      const siguienteFecha = addDays(ultimaCuota.fechaVencimiento, 30);
      const existePendienteMismaFecha = cuotas.some(
        (c) => c.fechaVencimiento === siguienteFecha && c.estado !== "Pagada"
      );

      if (!existePendienteMismaFecha) {
        cuotas = [
          ...cuotas,
          {
            id: `${loan.id}-${cuotas.length + 1}-${Date.now()}`,
            numero: cuotas.length + 1,
            fechaVencimiento: siguienteFecha,
            valorProgramado: interesMensual,
            capitalProgramado: 0,
            interesProgramado: interesMensual,
            valorPagado: 0,
            fechaPago: "",
            recordatorioEnviado: false,
            estado: "Pendiente",
          },
        ];
      }
    }
  }

  cuotas = cuotas.map((cuota) => {
    const valorPagado = Number(cuota.valorPagado || 0);
    const valorProgramado = Number(cuota.valorProgramado || 0);
    let estado = "Pendiente";

    if (valorPagado >= valorProgramado) estado = "Pagada";
    else if (valorPagado > 0) estado = "Abono";
    else if (cuota.fechaVencimiento < today) estado = "Vencida";

    return { ...cuota, estado };
  });

  const totalPagado = round2(
    (loan.paymentHistory || []).reduce((sum, payment) => sum + Number(payment.valor || 0), 0)
  );

  const capitalPendiente = round2(Number(loan.capitalPendiente ?? loan.capital ?? 0));

  const totalInteresPendiente = round2(
    cuotas.reduce((sum, cuota) => {
      return (
        sum +
        Math.max(0, Number(cuota.valorProgramado || 0) - Number(cuota.valorPagado || 0))
      );
    }, 0)
  );

  let saldoPendiente = 0;

  if (isSoloIntereses) {
    saldoPendiente = round2(capitalPendiente + totalInteresPendiente);
  } else {
    saldoPendiente = Math.max(0, round2(Number(loan.totalPagar || 0) - totalPagado));
  }

  const pagadas = cuotas.filter((c) => c.estado === "Pagada").length;
  const vencidas = cuotas.filter((c) => c.estado === "Vencida").length;
  const pendientes = cuotas.filter((c) => c.estado !== "Pagada").length;

  let estado = "Activo";

  if (!isSoloIntereses && saldoPendiente <= 0) {
    estado = "Finalizado";
  } else if (vencidas > 0) {
    estado = "En mora";
  }

  return {
    ...loan,
    cuotas,
    totalPagado,
    saldoPendiente,
    capitalPendiente,
    resumenCuotas: { pagadas, vencidas, pendientes },
    estado,
  };
}

function statusClass(status) {
  if (status === "Pagada" || status === "Finalizado" || status === "Activo") return "status ok";
  if (status === "Vencida" || status === "En mora") return "status bad";
  if (status === "Abono") return "status warn";
  return "status";
}

function buildWhatsAppUrl(loan, cuota) {
  const phone = onlyDigits(loan.telefono);
  const pending = Math.max(
    0,
    round2(Number(cuota.valorProgramado) - Number(cuota.valorPagado || 0))
  );

  const concepto =
    loan.frecuencia === "solo_intereses"
      ? "el pago de intereses del mes"
      : `el pago de la cuota ${cuota.numero}`;

  const text = `Hola ${loan.cliente}, te recordamos ${concepto} por valor de ${money(
    pending
  )} con vencimiento ${formatDate(cuota.fechaVencimiento)}. Gracias.`;

  return `https://wa.me/57${phone}?text=${encodeURIComponent(text)}`;
}

function matchesPdfFilter(loan, filter) {
  if (filter === "todos") return true;
  if (filter === "activos") return loan.estado === "Activo";
  if (filter === "activos_pendientes") return loan.estado !== "Finalizado";
  if (filter === "pagados") return loan.estado === "Finalizado";
  return true;
}

function App() {
  const [session, setSession] = useState(null);
  const access = useMemo(() => getSavedAccess(), []);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [newPassword, setNewPassword] = useState(access.password || DEFAULT_PASSWORD);

  const [clients, setClients] = useState(() => {
    const saved = localStorage.getItem(CLIENTS_KEY);
    if (!saved) return [];
    try {
      return JSON.parse(saved);
    } catch {
      return [];
    }
  });

  const [loans, setLoans] = useState(() => {
    const saved = localStorage.getItem(LOANS_KEY);
    if (!saved) return [];
    try {
      return JSON.parse(saved).map(recalculateLoan);
    } catch {
      return [];
    }
  });

  const [form, setForm] = useState({
    cliente: "",
    documento: "",
    telefono: "",
    direccion: "",
    capital: "",
    interesPct: "",
    plazoMeses: "",
    frecuencia: "semanal",
    fechaInicio: todayISO(),
  });

  const [clientExists, setClientExists] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [loanSearch, setLoanSearch] = useState("");
  const [loanStatusFilter, setLoanStatusFilter] = useState("todos");
  const [reminderSearch, setReminderSearch] = useState("");
  const [selectedLoanId, setSelectedLoanId] = useState("");
  const [selectedClientDocumento, setSelectedClientDocumento] = useState("");
  const [pdfFilter, setPdfFilter] = useState("todos");
  const [activeTab, setActiveTab] = useState("principal");

  const [payment, setPayment] = useState({
    cuotaId: "",
    valor: "",
    fechaPago: todayISO(),
  });

  useEffect(() => {
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(clients));
  }, [clients]);

  useEffect(() => {
    localStorage.setItem(LOANS_KEY, JSON.stringify(loans));
  }, [loans]);

useEffect(() => {
  supabase.auth.getSession().then(({ data: { session } }) => {
    setSession(session);
  });

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    setSession(session);
  });

  return () => subscription.unsubscribe();
}, []);




  useEffect(() => {
    if (!selectedLoanId && loans.length > 0) {
      setSelectedLoanId(loans[0].id);
    }
  }, [loans, selectedLoanId]);

  const filteredClientResults = useMemo(() => {
    const q = normalizeText(clientSearch);
    if (!q) return [];
    return clients
      .filter((client) => {
        const haystack = normalizeText(
          `${client.nombre} ${client.documento} ${client.telefono || ""}`
        );
        return haystack.includes(q);
      })
      .slice(0, 8);
  }, [clients, clientSearch]);

  const simulationClient = useMemo(() => {
    const doc = String(form.documento || "").trim();
    return getClientByDocument(clients, doc) || {
      clienteId: clientIdFromCount(clients.length),
      nombre: form.cliente,
      documento: doc,
      telefono: form.telefono,
      direccion: form.direccion,
    };
  }, [clients, form]);

  const simulation = useMemo(
    () => buildLoan(form, loans, simulationClient),
    [form, loans, simulationClient]
  );

  const filteredLoans = useMemo(() => {
    return loans.filter((loan) => {
      const text = normalizeText(
        `${loan.prestamoId} ${loan.clienteId} ${loan.cliente} ${loan.documento} ${loan.telefono}`
      );
      const searchMatch = text.includes(normalizeText(loanSearch));
      const statusMatch =
        loanStatusFilter === "todos"
          ? true
          : normalizeText(loan.estado) === normalizeText(loanStatusFilter);

      return searchMatch && statusMatch;
    });
  }, [loans, loanSearch, loanStatusFilter]);

  const selectedLoan = useMemo(() => {
    return loans.find((loan) => loan.id === selectedLoanId) || filteredLoans[0] || null;
  }, [loans, selectedLoanId, filteredLoans]);

  const selectedClientLoans = useMemo(() => {
    if (!selectedClientDocumento) return [];
    return loans
      .filter((loan) => String(loan.documentoCliente) === String(selectedClientDocumento))
      .sort((a, b) => new Date(b.fechaInicio) - new Date(a.fechaInicio));
  }, [loans, selectedClientDocumento]);

  const selectedClient = useMemo(() => {
    return clients.find((c) => String(c.documento) === String(selectedClientDocumento)) || null;
  }, [clients, selectedClientDocumento]);

  const pdfLoans = useMemo(() => {
    return selectedClientLoans.filter((loan) => matchesPdfFilter(loan, pdfFilter));
  }, [selectedClientLoans, pdfFilter]);

  const reminders = useMemo(() => {
    const today = todayISO();
    const next3 = addDays(today, 3);
    const items = [];

    loans.forEach((loan) => {
      loan.cuotas.forEach((cuota) => {
        if (cuota.estado === "Pagada") return;
        if (cuota.fechaVencimiento <= next3) {
          items.push({ loan, cuota });
        }
      });
    });

    return items
      .filter(({ loan }) => {
        const haystack = normalizeText(
          `${loan.cliente} ${loan.documentoCliente} ${loan.telefono || ""}`
        );
        return haystack.includes(normalizeText(reminderSearch));
      })
      .sort((a, b) => a.cuota.fechaVencimiento.localeCompare(b.cuota.fechaVencimiento));
  }, [loans, reminderSearch]);

  const summary = useMemo(() => {
    return {
      totalPrestado: loans.reduce((sum, loan) => sum + Number(loan.capital || 0), 0),
      totalCobrado: loans.reduce((sum, loan) => sum + Number(loan.totalPagado || 0), 0),
      totalInteres: loans.reduce((sum, loan) => sum + Number(loan.interesTotal || 0), 0),
      enMora: loans.filter((loan) => loan.estado === "En mora").length,
      recordatorios: reminders.length,
      clientes: clients.length,
    };
  }, [loans, reminders, clients]);

  function applyClientToForm(client) {
    if (!client) return;
    setClientExists(true);
    setForm((prev) => ({
      ...prev,
      cliente: client.nombre || "",
      documento: client.documento || "",
      telefono: client.telefono || "",
      direccion: client.direccion || "",
    }));
    setSelectedClientDocumento(client.documento || "");
    setClientSearch("");
  }

  function handleChange(event) {
    const { name, value } = event.target;

    if (name === "documento") {
      const documentoLimpio = String(value || "").trim();
      const existingClient = getClientByDocument(clients, documentoLimpio);

      if (existingClient) {
        applyClientToForm(existingClient);
        return;
      } else {
        setClientExists(false);
        setForm((prev) => ({
          ...prev,
          documento: documentoLimpio,
          cliente: "",
          telefono: "",
          direccion: "",
        }));
        return;
      }
    }

    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function login() {
    if (loginPassword === (access.password || DEFAULT_PASSWORD)) {
      setIsAuthenticated(true);
      setLoginPassword("");
    } else {
      alert("Contraseña incorrecta.");
    }
  }

  function changePassword() {
    if (!newPassword.trim()) {
      alert("Ingresa una contraseña válida.");
      return;
    }
    saveAccess({ password: newPassword.trim() });
    alert("Contraseña actualizada correctamente.");
  }

  function saveLoan() {
    const documento = String(form.documento || "").trim();

    if (!documento) {
      alert("Debes ingresar el número de documento.");
      return;
    }

    let existingClient = getClientByDocument(clients, documento);
    let clientToUse = existingClient;

    if (!existingClient) {
      clientToUse = {
        clienteId: clientIdFromCount(clients.length),
        documento,
        nombre: form.cliente,
        telefono: form.telefono,
        direccion: form.direccion,
        createdAt: new Date().toISOString(),
      };

      if (!clientToUse.nombre) {
        alert("Debes ingresar el nombre del cliente.");
        return;
      }

      setClients((prev) => [...prev, clientToUse]);
    } else {
      const updatedClient = {
        ...existingClient,
        nombre: form.cliente || existingClient.nombre,
        telefono: form.telefono || existingClient.telefono,
        direccion: form.direccion || existingClient.direccion,
      };
      clientToUse = updatedClient;

      setClients((prev) =>
        prev.map((client) =>
          String(client.documento) === documento ? updatedClient : client
        )
      );
    }

    const loan = buildLoan(form, loans, clientToUse);

    if (!loan) {
      alert("Completa los datos obligatorios del préstamo.");
      return;
    }

    setLoans((prev) => [loan, ...prev]);
    setSelectedLoanId(loan.id);
    setSelectedClientDocumento(clientToUse.documento);
    setActiveTab("principal");

    setForm({
      cliente: clientToUse.nombre || "",
      documento: clientToUse.documento || "",
      telefono: clientToUse.telefono || "",
      direccion: clientToUse.direccion || "",
      capital: "",
      interesPct: "",
      plazoMeses: "",
      frecuencia: "semanal",
      fechaInicio: todayISO(),
    });

    setClientExists(true);
  }

  function registerPayment() {
    if (!selectedLoan || !payment.cuotaId || !payment.valor || !payment.fechaPago) {
      alert("Selecciona una cuota, valor y fecha del pago.");
      return;
    }

    const valor = Number(payment.valor || 0);

    if (valor <= 0) {
      alert("El valor del pago debe ser mayor que cero.");
      return;
    }

    setLoans((prev) =>
      prev.map((loan) => {
        if (loan.id !== selectedLoan.id) return loan;

        const cuotaObjetivo = loan.cuotas.find((c) => c.id === payment.cuotaId);
        if (!cuotaObjetivo) return loan;

        const updatedCuotas = loan.cuotas.map((cuota) => {
          if (cuota.id !== payment.cuotaId) return cuota;

          return {
            ...cuota,
            valorPagado: round2(Number(cuota.valorPagado || 0) + valor),
            fechaPago: payment.fechaPago,
          };
        });

        const paymentEvent = {
          id: `${loan.id}-pay-${Date.now()}`,
          cuotaId: payment.cuotaId,
          cuotaNumero: cuotaObjetivo.numero,
          valor,
          fechaPago: payment.fechaPago,
          tipo: valor < Number(cuotaObjetivo.valorProgramado || 0) ? "Abono" : "Pago",
          createdAt: new Date().toISOString(),
        };

        return recalculateLoan({
          ...loan,
          cuotas: updatedCuotas,
          paymentHistory: [...(loan.paymentHistory || []), paymentEvent],
        });
      })
    );

    setPayment({ cuotaId: "", valor: "", fechaPago: todayISO() });
  }

  function deleteLoan(id) {
    if (!window.confirm("¿Deseas eliminar este préstamo?")) return;
    setLoans((prev) => prev.filter((loan) => loan.id !== id));
    if (selectedLoanId === id) setSelectedLoanId("");
  }

  function markReminderSent(loanId, cuotaId) {
    setLoans((prev) =>
      prev.map((loan) => {
        if (loan.id !== loanId) return loan;
        return {
          ...loan,
          cuotas: loan.cuotas.map((cuota) =>
            cuota.id === cuotaId ? { ...cuota, recordatorioEnviado: true } : cuota
          ),
        };
      })
    );
  }

  function generateUserPdf() {
    if (!selectedClient || !pdfLoans.length) {
      alert("Selecciona un usuario con préstamos para generar el PDF.");
      return;
    }

    const reportTitleMap = {
      todos: "Todos los préstamos",
      activos: "Préstamos activos",
      activos_pendientes: "Préstamos activos pendientes",
      pagados: "Préstamos pagados",
    };

    const loansHtml = pdfLoans
      .map((loan) => {
        const cuotasHtml = (loan.cuotas || [])
          .map(
            (cuota) => `
            <tr>
              <td>${cuota.numero}</td>
              <td>${formatDate(cuota.fechaVencimiento)}</td>
              <td>${money(cuota.valorProgramado)}</td>
              <td>${money(cuota.valorPagado)}</td>
              <td>${formatDate(cuota.fechaPago)}</td>
              <td>${cuota.estado}</td>
            </tr>
          `
          )
          .join("");

        const pagosHtml =
          loan.paymentHistory && loan.paymentHistory.length
            ? loan.paymentHistory
                .map(
                  (pago) => `
                <tr>
                  <td>${pago.cuotaNumero}</td>
                  <td>${pago.tipo}</td>
                  <td>${money(pago.valor)}</td>
                  <td>${formatDate(pago.fechaPago)}</td>
                </tr>
              `
                )
                .join("")
            : `<tr><td colspan="4">Sin pagos registrados</td></tr>`;

        return `
          <div class="loan-block">
            <h3>Préstamo ${loan.prestamoId}</h3>
            <p><strong>Fecha inicio:</strong> ${formatDate(loan.fechaInicio)}</p>
            <p><strong>Frecuencia:</strong> ${frecuencias[loan.frecuencia]?.label || loan.frecuencia}</p>
            <p><strong>Estado:</strong> ${loan.estado}</p>
            <p><strong>Capital:</strong> ${money(loan.capital)}</p>
            <p><strong>Capital pendiente:</strong> ${money(loan.capitalPendiente || loan.capital)}</p>
            <p><strong>Total pagado:</strong> ${money(loan.totalPagado)}</p>
            <p><strong>Saldo pendiente:</strong> ${money(loan.saldoPendiente)}</p>

            <h4>Detalle de cuotas</h4>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Vence</th>
                  <th>Programado</th>
                  <th>Pagado</th>
                  <th>Fecha pago</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>${cuotasHtml}</tbody>
            </table>

            <h4>Historial de pagos y abonos</h4>
            <table>
              <thead>
                <tr>
                  <th>Cuota</th>
                  <th>Tipo</th>
                  <th>Valor</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>${pagosHtml}</tbody>
            </table>
          </div>
        `;
      })
      .join("");

    const totalCapital = pdfLoans.reduce((sum, loan) => sum + Number(loan.capital || 0), 0);
    const totalPagado = pdfLoans.reduce((sum, loan) => sum + Number(loan.totalPagado || 0), 0);
    const totalSaldo = pdfLoans.reduce((sum, loan) => sum + Number(loan.saldoPendiente || 0), 0);

    const html = `
      <html>
        <head>
          <title>Reporte de préstamos - ${selectedClient.nombre}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #222; }
            h1, h2, h3, h4 { margin-bottom: 8px; }
            p { margin: 4px 0; }
            .header-box, .summary-box, .loan-block {
              border: 1px solid #f3f0f0; border-radius: 12px; padding: 16px; margin-bottom: 18px;
            }
            .summary-grid {
              display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
            }
            .summary-item {
              border: 1px solid #ddd; border-radius: 10px; padding: 10px;
            }
            table {
              width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 14px; font-size: 12px;
            }
            th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
            th { background: #f2f2f2; }
            @media print {
              body { padding: 0; }
              .loan-block { page-break-inside: avoid; }
            }
          </style>
        </head>
        <body>
          <div class="header-box">
            <h1>Reporte de préstamos del usuario</h1>
            <p><strong>Cliente:</strong> ${selectedClient.nombre}</p>
            <p><strong>ID Cliente:</strong> ${selectedClient.clienteId}</p>
            <p><strong>Documento:</strong> ${selectedClient.documento}</p>
            <p><strong>Teléfono:</strong> ${selectedClient.telefono || "-"}</p>
            <p><strong>Dirección:</strong> ${selectedClient.direccion || "-"}</p>
            <p><strong>Filtro:</strong> ${reportTitleMap[pdfFilter]}</p>
            <p><strong>Fecha del reporte:</strong> ${new Date().toLocaleString("es-CO")}</p>
          </div>

          <div class="summary-box">
            <h2>Resumen</h2>
            <div class="summary-grid">
              <div class="summary-item"><strong>Total préstamos</strong><div>${pdfLoans.length}</div></div>
              <div class="summary-item"><strong>Total capital</strong><div>${money(totalCapital)}</div></div>
              <div class="summary-item"><strong>Total pagado</strong><div>${money(totalPagado)}</div></div>
              <div class="summary-item"><strong>Saldo pendiente</strong><div>${money(totalSaldo)}</div></div>
            </div>
          </div>

          ${loansHtml}
        </body>
      </html>
    `;

    const printWindow = window.open("", "_blank", "width=1000,height=800");
    if (!printWindow) {
      alert("El navegador bloqueó la ventana emergente. Permite ventanas emergentes para generar el PDF.");
      return;
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();

    setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 400);
  }

  if (!isAuthenticated) {
    return (
      <div className="app-shell login-shell">
        <div className="login-content">
          <div className="login-card">
            <h1>Control Préstamos</h1>
            <p>Ingresa la contraseña para acceder.</p>

            <input
              type="password"
              placeholder="Contraseña"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && login()}
            />

            <button className="btn" onClick={login}>
              Ingresar
            </button>

              <button
               className="btn"
               onClick={() => supabase.auth.signOut()}
                >
               Salir
            </button>
            <small>Ing. Luis Carlos Hurtado Castañeda</small>
          </div>
        </div>

        
      </div>
    );
  }
if (!session) {
  return <LoginScreen />;
}
  return (
    <div className="app-shell">
      <div className="container">
        <header className="header">
          <div>
            <h1>Control Préstamos</h1>
          </div>
          <div className="creator-box">
            <img src="/control-prestamos/logo.png" alt="logo" className="logo-header" />
          </div>
        </header>

        <section className="summary-grid summary-grid-6">
          <div className="card summary-card">
            <span>Clientes</span>
            <strong>{summary.clientes}</strong>
          </div>
          <div className="card summary-card">
            <span>Total prestado</span>
            <strong>{money(summary.totalPrestado)}</strong>
          </div>
          <div className="card summary-card">
            <span>Total cobrado</span>
            <strong>{money(summary.totalCobrado)}</strong>
          </div>
          <div className="card summary-card">
            <span>Interés esperado</span>
            <strong>{money(summary.totalInteres)}</strong>
          </div>
          <div className="card summary-card">
            <span>Préstamos en mora</span>
            <strong>{summary.enMora}</strong>
          </div>
          <div className="card summary-card">
            <span>Recordatorios</span>
            <strong>{summary.recordatorios}</strong>
          </div>
        </section>

        <section className="tabs-bar">
          <button
            className={`tab-btn ${activeTab === "principal" ? "active" : ""}`}
            onClick={() => setActiveTab("principal")}
          >
            Principal
          </button>
          <button
            className={`tab-btn ${activeTab === "cartera" ? "active" : ""}`}
            onClick={() => setActiveTab("cartera")}
          >
            Cartera
          </button>
          <button
            className={`tab-btn ${activeTab === "reportes" ? "active" : ""}`}
            onClick={() => setActiveTab("reportes")}
          >
            Reportes
          </button>
          <button
            className={`tab-btn ${activeTab === "configuracion" ? "active" : ""}`}
            onClick={() => setActiveTab("configuracion")}
          >
            Configuración
          </button>
        </section>

        {activeTab === "principal" && (
          <>
            <section className="grid-2">
              <div className="card">
                <h2>Nuevo préstamo</h2>

                <div className="form-grid single-gap" style={{ marginBottom: 16 }}>
                  <div>
                    <label>Buscar cliente existente</label>
                    <input
                      type="text"
                      placeholder="Escribe nombre, documento o teléfono"
                      value={clientSearch}
                      onChange={(e) => setClientSearch(e.target.value)}
                    />
                  </div>

                  {filteredClientResults.length > 0 && (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Cliente</th>
                            <th>Documento</th>
                            <th>Teléfono</th>
                            <th>Acción</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredClientResults.map((client) => (
                            <tr key={client.documento}>
                              <td>{client.nombre}</td>
                              <td>{client.documento}</td>
                              <td>{client.telefono || "-"}</td>
                              <td>
                                <button
                                  type="button"
                                  className="btn small"
                                  onClick={() => applyClientToForm(client)}
                                >
                                  Seleccionar
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="form-grid">
                  <div>
                    <label>Documento</label>
                    <input
                      name="documento"
                      value={form.documento}
                      onChange={handleChange}
                      placeholder="Ingresa el documento"
                    />
                  </div>

                  <div>
                    <label>ID cliente</label>
                    <input value={simulationClient?.clienteId || "-"} disabled />
                  </div>

                  <div>
                    <label>Cliente</label>
                    <input
                      name="cliente"
                      value={form.cliente}
                      onChange={handleChange}
                      disabled={clientExists}
                      placeholder="Nombre del cliente"
                    />
                  </div>

                  <div>
                    <label>Teléfono</label>
                    <input
                      name="telefono"
                      value={form.telefono}
                      onChange={handleChange}
                      disabled={clientExists}
                      placeholder="Teléfono"
                    />
                  </div>

                  <div>
                    <label>Dirección</label>
                    <input
                      name="direccion"
                      value={form.direccion}
                      onChange={handleChange}
                      disabled={clientExists}
                      placeholder="Dirección"
                    />
                  </div>

                  <div className="client-status-box">
                    <label>Estado del cliente</label>
                    <input
                      value={clientExists ? "Cliente existente" : "Cliente nuevo"}
                      disabled
                    />
                  </div>

                  <div>
                    <label>Capital</label>
                    <input
                      name="capital"
                      type="number"
                      value={form.capital}
                      onChange={handleChange}
                    />
                  </div>

                  <div>
                    <label>Interés mensual (%)</label>
                    <input
                      name="interesPct"
                      type="number"
                      value={form.interesPct}
                      onChange={handleChange}
                    />
                  </div>

                  <div>
                    <label>Plazo (meses)</label>
                    <input
                      name="plazoMeses"
                      type="number"
                      value={form.plazoMeses}
                      onChange={handleChange}
                      disabled={form.frecuencia === "solo_intereses"}
                    />
                  </div>

                  <div>
                    <label>Frecuencia</label>
                    <select
                      name="frecuencia"
                      value={form.frecuencia}
                      onChange={handleChange}
                    >
                      <option value="semanal">Semanal</option>
                      <option value="quincenal">Quincenal</option>
                      <option value="mensual">Mensual</option>
                      <option value="solo_intereses">Solo intereses</option>
                    </select>
                  </div>

                  <div>
                    <label>Fecha de inicio</label>
                    <input
                      name="fechaInicio"
                      type="date"
                      value={form.fechaInicio}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="new-client-btn-box">
                    <label>&nbsp;</label>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => {
                        setClientExists(false);
                        setClientSearch("");
                        setForm((prev) => ({
                          ...prev,
                          cliente: "",
                          documento: "",
                          telefono: "",
                          direccion: "",
                        }));
                      }}
                    >
                      Nuevo cliente
                    </button>
                  </div>
                </div>

                <button className="btn" onClick={saveLoan}>
                  Guardar préstamo
                </button>
              </div>

              <div className="card">
                <h2>Simulación</h2>
                <div className="mini-grid">
                  <div className="mini-box">
                    <span>Cuotas</span>
                    <strong>{simulation?.cuotas?.length || 0}</strong>
                  </div>
                  <div className="mini-box">
                    <span>Valor cuota</span>
                    <strong>{money(simulation?.valorCuota || 0)}</strong>
                  </div>
                  <div className="mini-box">
                    <span>Interés total</span>
                    <strong>{money(simulation?.interesTotal || 0)}</strong>
                  </div>
                  <div className="mini-box">
                    <span>Total pagar</span>
                    <strong>{money(simulation?.totalPagar || 0)}</strong>
                  </div>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Vence</th>
                        <th>Capital</th>
                        <th>Interés</th>
                        <th>Cuota</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simulation?.cuotas?.length ? (
                        simulation.cuotas.map((cuota) => (
                          <tr key={cuota.id}>
                            <td>{cuota.numero}</td>
                            <td>{formatDate(cuota.fechaVencimiento)}</td>
                            <td>{money(cuota.capitalProgramado)}</td>
                            <td>{money(cuota.interesProgramado)}</td>
                            <td>{money(cuota.valorProgramado)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="5">Ingresa datos para ver la simulación.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="grid-2 payments-grid">
              <div className="card">
                <h2>Registrar pago</h2>
                {selectedLoan ? (
                  <>
                    <p><strong>Préstamo:</strong> {selectedLoan.prestamoId}</p>
                    <p><strong>ID Cliente:</strong> {selectedLoan.clienteId}</p>
                    <p><strong>Cliente:</strong> {selectedLoan.cliente}</p>
                    <p><strong>Tipo:</strong> {frecuencias[selectedLoan.frecuencia]?.label || selectedLoan.frecuencia}</p>
                    <p><strong>Capital pendiente:</strong> {money(selectedLoan.capitalPendiente || selectedLoan.capital)}</p>
                    <p><strong>Saldo pendiente:</strong> {money(selectedLoan.saldoPendiente)}</p>
                    <p><strong>Cuota normal:</strong> {money(selectedLoan.valorCuota)}</p>

                    <div className="form-grid single-gap">
                      <div>
                        <label>Cuota</label>
                        <select
                          value={payment.cuotaId}
                          onChange={(e) =>
                            setPayment((prev) => ({
                              ...prev,
                              cuotaId: e.target.value,
                            }))
                          }
                        >
                          <option value="">Selecciona una cuota</option>
                          {selectedLoan.cuotas
                            .filter((cuota) => cuota.estado !== "Pagada")
                            .map((cuota) => (
                              <option key={cuota.id} value={cuota.id}>
                                Cuota {cuota.numero} - pendiente {money(cuota.valorProgramado - cuota.valorPagado)}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label>Valor pagado o abono</label>
                        <input
                          type="number"
                          value={payment.valor}
                          onChange={(e) =>
                            setPayment((prev) => ({
                              ...prev,
                              valor: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label>Fecha de pago o abono</label>
                        <input
                          type="date"
                          value={payment.fechaPago}
                          onChange={(e) =>
                            setPayment((prev) => ({
                              ...prev,
                              fechaPago: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>

                    <button className="btn" onClick={registerPayment}>
                      Registrar pago
                    </button>
                  </>
                ) : (
                  <p>No hay préstamo seleccionado.</p>
                )}
              </div>

              <div className="card">
                <h2>Detalle de cuotas</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Vence</th>
                        <th>Programado</th>
                        <th>Pagado</th>
                        <th>Fecha pago</th>
                        <th>Falta</th>
                        <th>Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedLoan?.cuotas?.length ? (
                        selectedLoan.cuotas.map((cuota) => (
                          <tr key={cuota.id}>
                            <td>{cuota.numero}</td>
                            <td>{formatDate(cuota.fechaVencimiento)}</td>
                            <td>{money(cuota.valorProgramado)}</td>
                            <td>{money(cuota.valorPagado)}</td>
                            <td>{formatDate(cuota.fechaPago)}</td>
                            <td>{money(Math.max(0, cuota.valorProgramado - cuota.valorPagado))}</td>
                            <td>
                              <span className={statusClass(cuota.estado)}>{cuota.estado}</span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="7">Selecciona un préstamo para ver las cuotas.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="grid-2">
              <div className="card">
                <h2>Historial de pagos y abonos</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Cuota</th>
                        <th>Tipo</th>
                        <th>Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedLoan?.paymentHistory?.length ? (
                        [...selectedLoan.paymentHistory]
                          .sort((a, b) => new Date(b.fechaPago) - new Date(a.fechaPago))
                          .map((paymentItem) => (
                            <tr key={paymentItem.id}>
                              <td>{formatDate(paymentItem.fechaPago)}</td>
                              <td>{paymentItem.cuotaNumero}</td>
                              <td>{paymentItem.tipo}</td>
                              <td>{money(paymentItem.valor)}</td>
                            </tr>
                          ))
                      ) : (
                        <tr>
                          <td colSpan="4">No hay pagos o abonos registrados.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <h2>Préstamo seleccionado</h2>
                {selectedLoan ? (
                  <div className="selected-client-box">
                    <p><strong>Préstamo:</strong> {selectedLoan.prestamoId}</p>
                    <p><strong>Cliente:</strong> {selectedLoan.cliente}</p>
                    <p><strong>Documento:</strong> {selectedLoan.documentoCliente}</p>
                    <p><strong>Estado:</strong> {selectedLoan.estado}</p>
                    <p><strong>Frecuencia:</strong> {frecuencias[selectedLoan.frecuencia]?.label}</p>
                  </div>
                ) : (
                  <p className="muted">Selecciona un préstamo en la pestaña Cartera.</p>
                )}
              </div>
            </section>
          </>
        )}

        {activeTab === "cartera" && (
          <>
            <details className="card collapsible-card" open>
              <summary className="collapsible-summary">Recordatorios de cobro</summary>
              <div className="collapsible-body">
                <div className="section-head stack-mobile">
                  <div className="muted">Muestra cuotas vencidas o que vencen en los próximos 3 días.</div>
                  <input
                    placeholder="Buscar por cliente, documento o teléfono"
                    value={reminderSearch}
                    onChange={(e) => setReminderSearch(e.target.value)}
                  />
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>ID Cliente</th>
                        <th>Préstamo</th>
                        <th>Cliente</th>
                        <th>Teléfono</th>
                        <th>Cuota</th>
                        <th>Vence</th>
                        <th>Pendiente</th>
                        <th>Recordatorio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reminders.length ? (
                        reminders.map(({ loan, cuota }) => (
                          <tr key={cuota.id}>
                            <td>{loan.clienteId}</td>
                            <td>{loan.prestamoId}</td>
                            <td>{loan.cliente}</td>
                            <td>{loan.telefono || "-"}</td>
                            <td>{cuota.numero}</td>
                            <td>{formatDate(cuota.fechaVencimiento)}</td>
                            <td>{money(cuota.valorProgramado - cuota.valorPagado)}</td>
                            <td className="actions-cell">
                              {loan.telefono ? (
                                <a
                                  className="btn-link"
                                  href={buildWhatsAppUrl(loan, cuota)}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={() => markReminderSent(loan.id, cuota.id)}
                                >
                                  WhatsApp
                                </a>
                              ) : (
                                <span className="muted">Sin teléfono</span>
                              )}
                              <span className={cuota.recordatorioEnviado ? "status ok" : "status"}>
                                {cuota.recordatorioEnviado ? "Enviado" : "Pendiente"}
                              </span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="8">No hay recordatorios pendientes.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>

            <details className="card collapsible-card" open>
              <summary className="collapsible-summary">Préstamos registrados</summary>
              <div className="collapsible-body">
                <div className="section-head stack-mobile">
                  <h2 style={{ margin: 0 }}>Cartera</h2>
                  <div className="report-actions">
                    <input
                      placeholder="Buscar por préstamo, cliente, documento o teléfono"
                      value={loanSearch}
                      onChange={(e) => setLoanSearch(e.target.value)}
                    />
                    <select
                      value={loanStatusFilter}
                      onChange={(e) => setLoanStatusFilter(e.target.value)}
                    >
                      <option value="todos">Todos</option>
                      <option value="Activo">Activo</option>
                      <option value="En mora">En mora</option>
                      <option value="Finalizado">Pagado</option>
                    </select>
                  </div>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Préstamo</th>
                        <th>ID Cliente</th>
                        <th>Cliente</th>
                        <th>Capital</th>
                        <th>Total pagar</th>
                        <th>Saldo</th>
                        <th>Frecuencia</th>
                        <th>Estado</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLoans.length ? (
                        filteredLoans.map((loan) => (
                          <tr key={loan.id}>
                            <td>{loan.prestamoId}</td>
                            <td>{loan.clienteId}</td>
                            <td>{loan.cliente}</td>
                            <td>{money(loan.capital)}</td>
                            <td>{money(loan.totalPagar)}</td>
                            <td>{money(loan.saldoPendiente)}</td>
                            <td>{frecuencias[loan.frecuencia]?.label}</td>
                            <td>
                              <span className={statusClass(loan.estado)}>{loan.estado}</span>
                            </td>
                            <td className="actions-cell">
                              <button
                                className="btn small"
                                onClick={() => {
                                  setSelectedLoanId(loan.id);
                                  setActiveTab("principal");
                                }}
                              >
                                Ver
                              </button>
                              <button
                                className="btn small"
                                onClick={() => setSelectedClientDocumento(loan.documentoCliente)}
                              >
                                Usuario
                              </button>
                              <button className="btn small danger" onClick={() => deleteLoan(loan.id)}>
                                Eliminar
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="9">No hay préstamos registrados.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </>
        )}

        {activeTab === "reportes" && (
          <section className="card">
            <div className="section-head stack-mobile">
              <h2>Reporte PDF por usuario</h2>
              <div className="report-actions">
                <select
                  value={selectedClientDocumento}
                  onChange={(e) => setSelectedClientDocumento(e.target.value)}
                >
                  <option value="">Selecciona un usuario</option>
                  {clients.map((client) => (
                    <option key={client.documento} value={client.documento}>
                      {client.nombre} - {client.documento}
                    </option>
                  ))}
                </select>

                <select value={pdfFilter} onChange={(e) => setPdfFilter(e.target.value)}>
                  <option value="todos">Todos</option>
                  <option value="activos">Activos</option>
                  <option value="activos_pendientes">Activos pendientes</option>
                  <option value="pagados">Pagados</option>
                </select>

                <button className="btn" onClick={generateUserPdf}>
                  Generar PDF
                </button>
              </div>
            </div>

            {selectedClient ? (
              <div className="selected-client-box">
                <p><strong>Cliente:</strong> {selectedClient.nombre}</p>
                <p><strong>Documento:</strong> {selectedClient.documento}</p>
                <p><strong>Teléfono:</strong> {selectedClient.telefono || "-"}</p>
                <p><strong>Préstamos encontrados:</strong> {pdfLoans.length}</p>
              </div>
            ) : (
              <p className="muted">Selecciona un usuario para generar el PDF.</p>
            )}
          </section>
        )}

        {activeTab === "configuracion" && (
          <section className="card">
            <h2>Configuración</h2>
            <p className="muted">
              </p>
            <div className="form-grid single-gap max-420">
              <div>
                <label>Nueva contraseña</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <button className="btn" onClick={changePassword}>
                Guardar contraseña
              </button>
            </div>
          </section>
        )}
      </div>

      <footer className="footer">
        <div className="footer-container">
          <p>© {new Date().getFullYear()} ING. LUIS CARLOS HURTADO CASTAÑEDA</p>
          <p className="footer-sub">Sistema de Control de Préstamos</p>
        </div>
      </footer>
    </div>
  );
}

export default App;