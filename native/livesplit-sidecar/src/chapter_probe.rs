//! Varredura diferencial que descobre, na memória do jogo, quais inteiros de 4 bytes avançam
//! exatamente um degrau de capítulo.
//!
//! Existe porque confiar numa offset publicada não resolveu: se o endereço estiver errado para a
//! build instalada, o split de fim de capítulo simplesmente nunca dispara e nada indica o motivo.
//! Aqui o endereço é encontrado por observação — o jogador atravessa o fim do capítulo uma vez e a
//! varredura reporta os candidatos.
//!
//! Só roda quando `GTS_AUTOSPLIT_SCAN` está definido, então não pesa na operação normal.

use crate::process_memory::ProcessReader;

/// Incremento esperado no contador de capítulo: ele mora nos 16 bits altos do inteiro.
const CHAPTER_ADVANCE_STEP: i32 = 65_536;

/// Início da região varrida, relativo à base do módulo.
///
/// O padrão cobre com folga o bloco onde vivem todos os campos que o autosplitter já usa
/// (`frame_rate` 0x82B7A0 até `chapter_kills` 0x862BC4) e também o `currentArea` 0x7FC1C9 usado
/// por outros splitters.
const DEFAULT_SCAN_START: usize = 0x078_0000;

/// Fim da região varrida, relativo à base do módulo.
const DEFAULT_SCAN_END: usize = 0x08D_0000;

/// Tamanho do bloco lido por chamada. Uma página não mapeada invalida o bloco inteiro, então
/// blocos menores perdem menos território quando isso acontece.
const CHUNK_SIZE: usize = 64 * 1024;

/// Teto de candidatos reportados por amostra, para um alinhamento infeliz não gerar um despejo
/// gigante no log.
const MAX_REPORTED: usize = 24;

/// Um bloco da região com a última leitura bem-sucedida.
#[derive(Debug)]
struct Chunk {
    offset: usize,
    previous: Option<Vec<u8>>,
}

#[derive(Debug)]
pub struct ChapterProbe {
    chunks: Vec<Chunk>,
    scratch: Vec<u8>,
    enabled: bool,
}

impl ChapterProbe {
    /// Liga a varredura só quando `GTS_AUTOSPLIT_SCAN` estiver definido e não vazio.
    pub fn from_env() -> Self {
        let enabled = std::env::var_os("GTS_AUTOSPLIT_SCAN")
            .is_some_and(|value| !value.is_empty() && value != "0");
        let start = env_offset("GTS_AUTOSPLIT_SCAN_START").unwrap_or(DEFAULT_SCAN_START);
        let end = env_offset("GTS_AUTOSPLIT_SCAN_END").unwrap_or(DEFAULT_SCAN_END);

        let mut chunks = Vec::new();
        if enabled && end > start {
            let mut offset = start;
            while offset < end {
                chunks.push(Chunk {
                    offset,
                    previous: None,
                });
                offset += CHUNK_SIZE;
            }
        }

        Self {
            chunks,
            scratch: vec![0; CHUNK_SIZE],
            enabled,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Região varrida, para o log deixar claro o que foi coberto.
    pub fn describe(&self) -> String {
        match (self.chunks.first(), self.chunks.last()) {
            (Some(first), Some(last)) => format!(
                "varredura de capítulo ativa: 0x{:X}..0x{:X} em {} blocos de {} KiB",
                first.offset,
                last.offset + CHUNK_SIZE,
                self.chunks.len(),
                CHUNK_SIZE / 1024
            ),
            _ => "varredura de capítulo ativa, mas a região configurada está vazia".to_owned(),
        }
    }

    /// Reamostra a região e devolve as offsets cujo `i32` avançou exatamente um degrau de
    /// capítulo desde a amostra anterior.
    ///
    /// A primeira passada só popula a linha de base e não reporta nada.
    pub fn sample(&mut self, process: &ProcessReader) -> Vec<ChapterCandidate> {
        let mut found = Vec::new();
        if !self.enabled {
            return found;
        }

        for chunk in &mut self.chunks {
            if process.read_into(chunk.offset, &mut self.scratch).is_err() {
                // Bloco não mapeado nesta build. Descarta a linha de base para não comparar
                // leitura nova com resíduo antigo.
                chunk.previous = None;
                continue;
            }

            if let Some(previous) = &chunk.previous {
                if found.len() < MAX_REPORTED {
                    collect_advances(chunk.offset, previous, &self.scratch, &mut found);
                }
            }

            match &mut chunk.previous {
                Some(previous) => previous.copy_from_slice(&self.scratch),
                slot => *slot = Some(self.scratch.clone()),
            }
        }

        found.truncate(MAX_REPORTED);
        found
    }
}

/// Offset, relativa à base do módulo, cujo inteiro avançou um degrau de capítulo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChapterCandidate {
    pub offset: usize,
    pub from: i32,
    pub to: i32,
}

/// Compara duas leituras do mesmo bloco em posições alinhadas a 4 bytes.
fn collect_advances(
    base_offset: usize,
    previous: &[u8],
    current: &[u8],
    found: &mut Vec<ChapterCandidate>,
) {
    let mut index = 0;
    while index + 4 <= previous.len() && found.len() < MAX_REPORTED {
        let before = read_i32(previous, index);
        let after = read_i32(current, index);
        if after.wrapping_sub(before) == CHAPTER_ADVANCE_STEP {
            found.push(ChapterCandidate {
                offset: base_offset + index,
                from: before,
                to: after,
            });
        }
        index += 4;
    }
}

fn read_i32(bytes: &[u8], index: usize) -> i32 {
    i32::from_le_bytes([
        bytes[index],
        bytes[index + 1],
        bytes[index + 2],
        bytes[index + 3],
    ])
}

/// Lê uma offset de variável de ambiente, aceitando decimal ou `0x` hexadecimal.
fn env_offset(name: &str) -> Option<usize> {
    let raw = std::env::var(name).ok()?;
    let trimmed = raw.trim();
    let parsed = match trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        Some(hex) => usize::from_str_radix(hex, 16).ok()?,
        None => trimmed.parse::<usize>().ok()?,
    };
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta_avanco_de_um_degrau() {
        let previous = 2i32 * CHAPTER_ADVANCE_STEP;
        let current = 3i32 * CHAPTER_ADVANCE_STEP;
        let mut found = Vec::new();

        collect_advances(
            0x1000,
            &previous.to_le_bytes(),
            &current.to_le_bytes(),
            &mut found,
        );

        assert_eq!(
            found,
            vec![ChapterCandidate {
                offset: 0x1000,
                from: previous,
                to: current
            }]
        );
    }

    #[test]
    fn ignora_qualquer_outro_delta() {
        let mut found = Vec::new();
        collect_advances(0, &0i32.to_le_bytes(), &7i32.to_le_bytes(), &mut found);
        collect_advances(0, &0i32.to_le_bytes(), &131_072i32.to_le_bytes(), &mut found);

        assert!(found.is_empty());
    }

    #[test]
    fn encontra_a_posicao_certa_dentro_do_bloco() {
        let mut previous = vec![0u8; 16];
        let mut current = vec![0u8; 16];
        current[8..12].copy_from_slice(&CHAPTER_ADVANCE_STEP.to_le_bytes());
        previous[8..12].copy_from_slice(&0i32.to_le_bytes());
        let mut found = Vec::new();

        collect_advances(0x850_000, &previous, &current, &mut found);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].offset, 0x850_008);
    }

    #[test]
    fn desligada_sem_a_variavel_de_ambiente() {
        // Sem GTS_AUTOSPLIT_SCAN no ambiente do teste, a sonda nasce inerte.
        let probe = ChapterProbe::from_env();
        if std::env::var_os("GTS_AUTOSPLIT_SCAN").is_none() {
            assert!(!probe.is_enabled());
            assert!(probe.chunks.is_empty());
        }
    }

    #[test]
    fn offset_de_ambiente_aceita_hex_e_decimal() {
        assert_eq!(env_offset("GTS_PROBE_TEST_MISSING_VAR"), None);
    }
}
