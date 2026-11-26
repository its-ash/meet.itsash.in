fn main() {
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icons/icon.ico");
        if let Err(e) = res.compile() {
            println!("cargo:warning=icon: {e}");
        }
    }
}
