#[cfg(windows)]
mod platform {
    use std::{ffi::c_void, mem};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::{
                Debug::ReadProcessMemory,
                ToolHelp::{
                    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Process32FirstW,
                    Process32NextW, MODULEENTRY32W, PROCESSENTRY32W, TH32CS_SNAPMODULE,
                    TH32CS_SNAPMODULE32, TH32CS_SNAPPROCESS,
                },
            },
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
        },
    };

    #[derive(Debug)]
    pub struct ProcessReader {
        handle: isize,
        process_id: u32,
        base_address: usize,
    }

    impl ProcessReader {
        pub fn attach(process_name: &str) -> Result<Option<Self>, String> {
            let Some(process_id) = find_process_id(process_name)? else {
                return Ok(None);
            };
            let base_address = find_module_base(process_id, process_name)?;
            let handle =
                unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, process_id) };
            if handle.is_null() {
                return Err(format!(
                    "Não foi possível abrir {process_name}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Some(Self {
                handle: handle as isize,
                process_id,
                base_address,
            }))
        }

        pub fn process_id(&self) -> u32 {
            self.process_id
        }

        pub fn read<T: Copy>(&self, offset: usize) -> Result<T, String> {
            let address = self
                .base_address
                .checked_add(offset)
                .ok_or_else(|| "Endereço de memória inválido.".to_owned())?;
            let mut value = mem::MaybeUninit::<T>::uninit();
            let mut bytes_read = 0usize;
            let result = unsafe {
                ReadProcessMemory(
                    self.handle as HANDLE,
                    address as *const c_void,
                    value.as_mut_ptr().cast::<c_void>(),
                    mem::size_of::<T>(),
                    &mut bytes_read,
                )
            };
            if result == 0 || bytes_read != mem::size_of::<T>() {
                return Err(format!(
                    "Falha ao ler memória do processo: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(unsafe { value.assume_init() })
        }

        /// Lê um bloco contíguo. Usado pela varredura que procura o contador de capítulo, que
        /// precisa comparar uma região inteira entre duas amostras.
        ///
        /// Falha inteira se qualquer página do intervalo não estiver mapeada, então quem chama
        /// deve fatiar a região em blocos e tolerar blocos que falhem.
        pub fn read_into(&self, offset: usize, buffer: &mut [u8]) -> Result<(), String> {
            let address = self
                .base_address
                .checked_add(offset)
                .ok_or_else(|| "Endereço de memória inválido.".to_owned())?;
            let mut bytes_read = 0usize;
            let result = unsafe {
                ReadProcessMemory(
                    self.handle as HANDLE,
                    address as *const c_void,
                    buffer.as_mut_ptr().cast::<c_void>(),
                    buffer.len(),
                    &mut bytes_read,
                )
            };
            if result == 0 || bytes_read != buffer.len() {
                return Err(format!(
                    "Falha ao ler bloco de memória: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
    }

    impl Drop for ProcessReader {
        fn drop(&mut self) {
            if self.handle != 0 {
                unsafe {
                    CloseHandle(self.handle as HANDLE);
                }
            }
        }
    }

    fn find_process_id(process_name: &str) -> Result<Option<u32>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(format!(
                "Não foi possível listar processos: {}",
                std::io::Error::last_os_error()
            ));
        }
        let result = (|| {
            let mut entry = unsafe { mem::zeroed::<PROCESSENTRY32W>() };
            entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
            if unsafe { Process32FirstW(snapshot, &mut entry) } == 0 {
                return Ok(None);
            }
            loop {
                if wide_string(&entry.szExeFile).eq_ignore_ascii_case(process_name) {
                    return Ok(Some(entry.th32ProcessID));
                }
                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    return Ok(None);
                }
            }
        })();
        unsafe {
            CloseHandle(snapshot);
        }
        result
    }

    fn find_module_base(process_id: u32, module_name: &str) -> Result<usize, String> {
        let snapshot = unsafe {
            CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, process_id)
        };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(format!(
                "Não foi possível localizar o módulo de {module_name}: {}",
                std::io::Error::last_os_error()
            ));
        }
        let result = (|| {
            let mut entry = unsafe { mem::zeroed::<MODULEENTRY32W>() };
            entry.dwSize = mem::size_of::<MODULEENTRY32W>() as u32;
            if unsafe { Module32FirstW(snapshot, &mut entry) } == 0 {
                return Err("O processo foi encontrado, mas seu módulo principal não.".to_owned());
            }
            loop {
                if wide_string(&entry.szModule).eq_ignore_ascii_case(module_name) {
                    return Ok(entry.modBaseAddr as usize);
                }
                if unsafe { Module32NextW(snapshot, &mut entry) } == 0 {
                    return Err("O módulo bio4.exe não foi encontrado no processo.".to_owned());
                }
            }
        })();
        unsafe {
            CloseHandle(snapshot);
        }
        result
    }

    fn wide_string(value: &[u16]) -> String {
        let end = value
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(value.len());
        String::from_utf16_lossy(&value[..end])
    }
}

#[cfg(windows)]
pub use platform::ProcessReader;

#[cfg(not(windows))]
#[derive(Debug)]
pub struct ProcessReader;

#[cfg(not(windows))]
impl ProcessReader {
    pub fn attach(_process_name: &str) -> Result<Option<Self>, String> {
        Err("Autosplit por memória só está disponível no Windows.".to_owned())
    }

    pub fn process_id(&self) -> u32 {
        0
    }

    pub fn read<T: Copy>(&self, _offset: usize) -> Result<T, String> {
        Err("Autosplit por memória só está disponível no Windows.".to_owned())
    }

    pub fn read_into(&self, _offset: usize, _buffer: &mut [u8]) -> Result<(), String> {
        Err("Autosplit por memória só está disponível no Windows.".to_owned())
    }
}
