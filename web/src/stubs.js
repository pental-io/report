// WHAT PENTAL REPORTER LEAVES OUT: a stand-in for each part of the paid product the engine mentions.
// Generated from Pental's portal (https://pental.io) by Pental's own tooling.
// Edit the shell (web/src/shell) rather than this file: it is regenerated for
// each release from the portal's code.
//
// Copyright (c) Pental Limited.
// SPDX-License-Identifier: AGPL-3.0-only

var CHECKLIST_RUNBOOK_LIBRARY = {};
var _DASH_GROUPS = [];
var _DASH_WIDGETS = {};
function _SCAN_FIELD_DEFS() { return []; }
var _SCAN_NOT_UPDATED = '';
var _SCAN_PROVIDER_COLS = null;
var _SCAN_SEV_ORDER = {};
var _TRACKER_COLS = '';
function _attestationOn() { return false; }
async function _bulkRaiseFindingTickets() { return Promise.resolve(null); }
function _canDeliverNow() { return false; }
function _checkInvoicePdfCache() { return; }
function _checkProposalPdfCache() { return; }
function _clientDocDownloadHtml() { return ''; }
function _clientDocPickerHtml() { return ''; }
function _clientDocShows() { return false; }
async function _copyRunbookCmd() { return Promise.resolve(null); }
function _dashEdAvailableWidgets() { return; }
function _dashEdDrag() { return; }
function _dashEdLoadLayoutForRole() { return {}; }
function _dashEdRoleName() { return; }
function _dashEdRoleOn() { return false; }
function _dashEdRoleWho() { return; }
function _dashEdUndoPreview() { return false; }
function _dashEdWaiting() { return; }
function _dashWidgetOn() { return false; }
function _docsBackWhenReady() { return; }
function _docsEngineBoot() { return; }
function _docsEngineKick() { return; }
function _dsTabHtml() { return ''; }
function _emailSignatureHtml() { return ''; }
function _findingTicketsHtml() { return ''; }
async function _finishDocsConnect() { return; }
async function _finishXeroConnect() { return Promise.resolve(null); }
function _initProposalPhases() { return; }
function _invAmountText() { return; }
function _invMoney() { return; }
function _invTeamShown() { return; }
function _isScanFinding() { return false; }
function _kitMail() { return; }
function _lfPaintQa() { return; }
function _lfQaBox() { return {}; }
function _loadSubscriptionData() { return Promise.resolve(null); }
async function _loadXeroExtras() { return Promise.resolve(null); }
function _mayDeliver() { return false; }
function _migPanelHtml() { return ''; }
function _onScanFindingPage() { return false; }
async function _patchProposalAuth() { return Promise.resolve(null); }
async function _payReturned() { return; }
function _pmBarHtml() { return ''; }
function _pmDests() { return; }
async function _pmLoad() { return Promise.resolve(null); }
function _pmOpFlush() { return; }
function _pmSettingsCardHtml() { return ''; }
async function _pmStatusLoad() { return Promise.resolve(null); }
async function _pmailCheck() { return; }
function _proposalFilename() { return; }
function _qaCanReview() { return false; }
function _qaChangeReads() { return; }
var _qaChangesCache = {};
function _qaClSettingsHtml() { return; }
function _qaClear() { return true; }
function _qaFigPair() { return []; }
async function _qaGoTo() { return Promise.resolve(null); }
function _qaIsPendingSuggestion() { return; }
async function _qaListOp() { return Promise.resolve(null); }
function _qaMarkupFor() { return null; }
function _qaMarkupToast() { return; }
function _qaOpenComments() { return; }
function _qaReadyToDeliver() { return; }
async function _qaRefetch() { return Promise.resolve(null); }
function _qaRelight() { return; }
function _qaResumeFailureModal() { return; }
var _qaResumeFor = null;
var _qaResumeKind = null;
function _qaReviewCopyAction() { return null; }
function _qaSelClear() { return; }
function _qaStickSync() { return; }
function _qaTargetOf() { return {}; }
function _qaWhere() { return; }
function _qaWriteMarkup() { return; }
function _renderAttestationTemplateFields() { return; }
function _renderInvoiceTemplateFields() { return; }
function _renderPhaseChecklistsPanel() { return ''; }
function _renderProposalTemplateFields() { return; }
async function _scanCap() { return Promise.resolve(null); }
function _scanCapNow() { return; }
function _scanFindingContext() { return {}; }
function _scanImportParse() { return {}; }
function _scanMapTargets() { return; }
function _scanProvidersHtml() { return; }
function _scanRunAsAssessment() { return null; }
function _scanStoredMap() { return; }
function _scanTemplateStyles() { return; }
function _scansNeedingFinalPdf() { return []; }
function _selfScanModuleOn() { return false; }
async function _showPushToken() { return Promise.resolve(null); }
function _ssApplianceAdd() { return; }
function _ssAppliancePicker() { return ''; }
async function _ssApplianceRemove() { return Promise.resolve(null); }
async function _ssApplianceUploadPick() { return Promise.resolve(null); }
function _ssAppliances() { return; }
async function _ssApplyKbLink() { return Promise.resolve(null); }
function _ssAtPerPaint() { return; }
function _ssCadenceFor() { return; }
function _ssCfg() { return {}; }
async function _ssDownloadScanReport() { return Promise.resolve(null); }
async function _ssLinkToKb() { return Promise.resolve(null); }
function _ssMoney() { return ''; }
function _ssOpenRun() { return; }
async function _ssProposeTarget() { return Promise.resolve(null); }
async function _ssRenameRun() { return Promise.resolve(null); }
function _ssRunFindings() { return; }
function _ssRunName() { return ''; }
function _ssRunSummaryHtml() { return ''; }
async function _ssSaveTarget() { return Promise.resolve(null); }
function _ssTargetWords() { return {}; }
function _ssTargets() { return; }
function _ssTypesOffered() { return; }
function _stripeStateHtml() { return ''; }
async function _syncPendingPictures() { return; }
async function _syncRecordChanges() { return 0; }
function _ticketsAfterRemediation() { return; }
async function _trialExpiredAddPayment() { return; }
function _xeroNote() { return ''; }
function _xeroWhyWords() { return ''; }
function addProposalPhase() { return; }
function canSeeProposals() { return; }
function clearLoaSignature() { return; }
async function confirmBankPayment() { return; }
async function confirmPayment() { return; }
async function connectXero() { return Promise.resolve(null); }
async function createInvoice() { return; }
async function deleteChecklistTemplate() { return Promise.resolve(null); }
async function deleteInvoice() { return Promise.resolve(null); }
async function deleteProposal() { return Promise.resolve(null); }
async function deliverReport() { return; }
async function discardWaitingXero() { return Promise.resolve(null); }
async function disconnectXero() { return Promise.resolve(null); }
async function downloadAttestation() { return; }
async function downloadInvoice() { return Promise.resolve(null); }
function downloadInvoicePdf() { return Promise.resolve(null); }
async function downloadProposal() { return; }
function downloadProposalPdf() { return; }
async function duplicateChecklistTemplate() { return Promise.resolve(null); }
async function duplicateProposal() { return Promise.resolve(null); }
async function genAttestationPDF() { return null; }
async function genInvoicePDF() { return null; }
async function genProposalDOCX() { return Promise.resolve(null); }
async function genProposalPDF() { return null; }
function getQAChanges() { return []; }
function hasBankPayment() { return false; }
function hasStripe() { return; }
async function importAllCuratedChecklists() { return Promise.resolve(null); }
async function importCuratedChecklist() { return Promise.resolve(null); }
function isContractor() { return; }
async function loadXeroStatus() { return Promise.resolve(null); }
async function loadXeroSyncLog() { return Promise.resolve(null); }
async function markInvoicePaid() { return Promise.resolve(null); }
async function markPaidByBank() { return; }
function meetCalendarEnabled() { return; }
async function mergeScanDuplicates() { return; }
function openChecklistEditor() { return; }
function openChecklistTransfer() { return; }
async function openLoaEditor() { return Promise.resolve(null); }
function openSetupWizard() { return; }
function openWithdrawDelivery() { return; }
function payInvoice() { return; }
function pdfFromDocxAttestation() { return null; }
function pdfFromDocxInvoice() { return; }
function pdfFromDocxProposal() { return; }
async function pushMissingToXero() { return Promise.resolve(null); }
async function removeLoASignature() { return Promise.resolve(null); }
function removeProposalPhase() { return; }
async function renderApplyConfirmation() { return ''; }
function renderCalendarPage() { return ''; }
function renderChecklistEditorModal() { return; }
function renderChecklistTransferModal() { return ''; }
function renderClientDetail() { return ''; }
function renderClientFindings() { return ''; }
function renderClientUserModal() { return ''; }
function renderClients() { return ''; }
function renderCollectorTokenModal() { return; }
function renderContactsPage() { return ''; }
function renderContractorsPage() { return ''; }
function renderDashboard() { return ''; }
function renderFeedbackModal() { return; }
function renderFeedbackPage() { return ''; }
function renderFeedbackStatus() { return ''; }
function renderInvoiceModal() { return; }
function renderInvoiceStatus() { return ''; }
function renderInvoiceViewModal() { return ''; }
function renderInvoices() { return ''; }
function renderLoAColumn() { return ''; }
function renderLoaEditorModal() { return ''; }
function renderMeetingModal() { return; }
function renderMeetingsPage() { return ''; }
function renderMigrateModal() { return ''; }
function renderPaymentAllModal() { return ''; }
function renderPaymentModal() { return ''; }
function renderProposalColumn() { return ''; }
function renderProposalModal() { return; }
function renderProposalsPage() { return ''; }
function renderPushTokenModal() { return; }
function renderQACommentModal() { return; }
function renderQAInlineCommentModal() { return; }
function renderQAQueue() { return ''; }
function renderQAReview() { return ''; }
function renderQASuggestEditModal() { return ''; }
function renderRetests() { return ''; }
function renderScanAuthModal() { return; }
function renderScanCadenceModal() { return; }
function renderScanDetail() { return ''; }
function renderScanImportModal() { return ''; }
function renderScanPickClientModal() { return; }
function renderScanPlanModal() { return; }
function renderScanProviderModal() { return; }
function renderScanTargetsModal() { return; }
function renderScans() { return ''; }
function renderSetupWizard() { return ''; }
function renderSignModal() { return ''; }
function renderSignatures() { return ''; }
function renderSubscriptionPage() { return ''; }
function renderTrackerModal() { return; }
function renderViewContractorModal() { return ''; }
function renderWithdrawDeliveryModal() { return ''; }
async function reopenQAApproval() { return Promise.resolve(null); }
async function resubmitToQA() { return Promise.resolve(null); }
async function retryFailedXeroTasks() { return Promise.resolve(null); }
async function saveChecklistFeatureToggle() { return Promise.resolve(null); }
async function saveLoASettings() { return Promise.resolve(null); }
async function saveLoaDrawnSignature() { return Promise.resolve(null); }
async function saveMeetingIntegration() { return Promise.resolve(null); }
async function saveMeetingIntegrations() { return Promise.resolve(null); }
async function savePaymentSettings() { return; }
async function saveProposalSettings() { return Promise.resolve(null); }
async function saveSelfScanSettings() { return Promise.resolve(null); }
async function saveXeroSettings() { return Promise.resolve(null); }
async function sendInvoice() { return; }
async function sendProposal() { return Promise.resolve(null); }
async function startQAReview() { return Promise.resolve(null); }
async function submitForQA() { return Promise.resolve(null); }
function switchLoaSigTab() { return; }
async function testStripeConnection() { return Promise.resolve(null); }
function testingCalendarEnabled() { return; }
function uploadLoASignature() { return; }
async function viewClient() { return; }
